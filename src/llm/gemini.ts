// =============================================================================
// Eyes-MCP — Gemini / Gemma 4 31B client
//
// Uses the Google AI Studio (generativelanguage.googleapis.com) endpoint,
// which is Gemini-compatible and also serves Gemma 4 31B. We call
// `:generateContent` directly via undici (built-in fetch is also fine; we use
// undici so we can set timeouts explicitly).
//
// Structured output uses Gemini's `responseSchema` (a subset of JSON Schema).
// We translate a small set of Zod types to that schema inline — no external
// dep needed.
// =============================================================================

import { z } from "zod";
import { request } from "undici";
import type {
  GenerateOptions,
  GenerateResult,
  LLMClient,
} from "./client.js";
import { LlmHttpError, MissingApiKeyError } from "./client.js";

// ---------------------------------------------------------------------------
// Zod -> Gemini responseSchema conversion
//
// Gemini accepts a subset of OpenAPI 3.0 Schema. We handle the types our
// prompts actually use: object, string, number, boolean, array, enum.
// Anything else throws — fail loudly rather than silently send "type: object"
// and hope.
// ---------------------------------------------------------------------------

type GeminiSchema = {
  type: "object" | "string" | "number" | "boolean" | "array" | "integer";
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  description?: string;
};

function zodToGemini(schema: z.ZodTypeAny, path: string): GeminiSchema {
  // Unwrap optional / nullable / default wrappers — Gemini doesn't model
  // nullability, so we just describe the inner type. Required-ness is
  // expressed via the parent's `required` array.
  let inner: z.ZodTypeAny = schema;
  let optional = false;
  while (true) {
    const def = (inner as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    const t = def?.typeName;
    if (t === "ZodOptional" || t === "ZodNullable") {
      inner = (def as { innerType: z.ZodTypeAny }).innerType;
      optional = true;
    } else if (t === "ZodDefault") {
      inner = (def as { innerType: z.ZodTypeAny }).innerType;
      optional = true; // defaults make a field optional for our purposes
    } else {
      break;
    }
  }
  void optional; // currently unused at this level; required-handling done by caller

  const def = (inner as { _def?: { typeName?: string; values?: readonly unknown[]; value?: unknown; shape?: Record<string, z.ZodTypeAny>; type?: z.ZodTypeAny; description?: string } })._def;
  const typeName = def?.typeName;
  const description = def?.description;

  switch (typeName) {
    case "ZodString": {
      const out: GeminiSchema = { type: "string" };
      if (description) out.description = description;
      return out;
    }
    case "ZodNumber": {
      const out: GeminiSchema = { type: "number" };
      if (description) out.description = description;
      return out;
    }
    case "ZodBoolean": {
      const out: GeminiSchema = { type: "boolean" };
      if (description) out.description = description;
      return out;
    }
    case "ZodEnum": {
      const values = (def as { values: readonly [string, ...string[]] }).values;
      const out: GeminiSchema = { type: "string", enum: [...values] };
      if (description) out.description = description;
      return out;
    }
    case "ZodLiteral": {
      const v = (def as { value: unknown }).value;
      if (typeof v === "string") return { type: "string", enum: [v] };
      if (typeof v === "number") return { type: "number" };
      if (typeof v === "boolean") return { type: "boolean" };
      throw new Error(`zodToGemini: unsupported literal at ${path}: ${String(v)}`);
    }
    case "ZodArray": {
      const elementType = (def as { type: z.ZodTypeAny }).type;
      const out: GeminiSchema = {
        type: "array",
        items: zodToGemini(elementType, `${path}[]`),
      };
      if (description) out.description = description;
      return out;
    }
    case "ZodObject": {
      const shape = (def as { shape: Record<string, z.ZodTypeAny> }).shape;
      const properties: Record<string, GeminiSchema> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(shape)) {
        const child = zodToGemini(sub, `${path}.${key}`);
        // Determine if this key is required (no optional/nullable/default wrapper).
        const childDef = (sub as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
        const childType = childDef?.typeName;
        const isOptional =
          childType === "ZodOptional" || childType === "ZodNullable" || childType === "ZodDefault";
        properties[key] = child;
        if (!isOptional) required.push(key);
      }
      const out: GeminiSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      if (description) out.description = description;
      return out;
    }
    default:
      throw new Error(
        `zodToGemini: unsupported Zod type "${String(typeName)}" at ${path}. ` +
          `Supported: ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodLiteral, ZodArray, ZodObject.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Concrete client
// ---------------------------------------------------------------------------

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Total request timeout in ms. Default 60s. */
  timeoutMs?: number;
}

export class GeminiClient implements LLMClient {
  public readonly model: string;
  public readonly isConfigured = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: GeminiClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? process.env["GEMINI_MODEL"] ?? "gemma-4-31b-it";
    this.baseUrl = (opts.baseUrl ?? process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const wantsStructured = options.structured === true || options.responseSchema !== undefined;

    // Build generationConfig. Gemini rejects unknown fields, so we only add
    // what's relevant.
    const generationConfig: Record<string, unknown> = {};
    if (typeof options.maxTokens === "number") {
      generationConfig["maxOutputTokens"] = options.maxTokens;
    }
    if (typeof options.temperature === "number") {
      generationConfig["temperature"] = options.temperature;
    }
    if (options.responseSchema) {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = zodToGemini(options.responseSchema, "$");
    } else if (wantsStructured) {
      generationConfig["responseMimeType"] = "application/json";
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };
    if (Object.keys(generationConfig).length > 0) {
      body["generationConfig"] = generationConfig;
    }
    if (options.system) {
      // Gemini uses a top-level `systemInstruction` field.
      body["systemInstruction"] = { role: "system", parts: [{ text: options.system }] };
    }

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    let res;
    try {
      res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (err) {
      // Network / timeout — wrap with a clear message.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM request to ${this.model} failed: ${message}`);
    }

    const raw = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new LlmHttpError(res.statusCode, raw);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM returned non-JSON: ${message}. Body: ${raw.slice(0, 300)}`);
    }

    // Gemini's response shape:
    //   { candidates: [{ content: { parts: [{ text: "..." }] } }],
    //     usageMetadata: { promptTokenCount, candidatesTokenCount } }
    const responseObj = parsed as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const candidate = responseObj.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

    const tokensIn = responseObj.usageMetadata?.promptTokenCount ?? 0;
    const tokensOut = responseObj.usageMetadata?.candidatesTokenCount ?? 0;

    // If a schema was requested, try to parse the text as JSON. Gemini usually
    // returns valid JSON when responseMimeType is set, but we don't crash if
    // it doesn't — callers can fall back to plain text.
    let structured: unknown | undefined;
    if (options.responseSchema) {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        try {
          const obj = JSON.parse(trimmed);
          const result = options.responseSchema.safeParse(obj);
          structured = result.success ? result.data : obj;
        } catch {
          structured = undefined;
        }
      }
    }

    return { text, tokensIn, tokensOut, structured };
  }
}

/**
 * Factory: returns a configured GeminiClient, or null if the API key is
 * missing. The main agent uses this to decide whether to run in LLM mode
 * or heuristic-only mode.
 */
export function createGeminiClient(): GeminiClient | null {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey || apiKey.trim() === "") {
    return null;
  }
  return new GeminiClient({ apiKey });
}

/**
 * Exported for testing — not for use outside this module.
 * @internal
 */
export const __internal = { zodToGemini };
