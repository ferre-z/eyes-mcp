// =============================================================================
// Eyes-MCP — OpenAI-compatible LLM client
//
// Works with any OpenAI-shape endpoint. Concretely supported today:
//   * Google AI Studio  https://generativelanguage.googleapis.com/v1beta/openai
//                        (serves Gemini + Gemma via the OpenAI-compatible API)
//   * OpenRouter        https://openrouter.ai/api/v1
//                        (free tier for many open models)
//
// The same request body (`{model, messages, response_format}`) hits both,
// with provider-specific auth and headers. We DON'T use the raw Gemini
// `generateContent` endpoint — the OpenAI-compatible one is the future-proof
// surface and the only one Google documents as stable for Gemma via
// AI Studio.
// =============================================================================

import { request } from "undici";
import { z } from "zod";
import type { GenerateOptions, GenerateResult, LLMClient } from "./client.js";
import { LlmHttpError } from "./client.js";

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export interface ProviderSpec {
  id: "google-ai-studio" | "openrouter";
  /** Base URL (no trailing slash). */
  baseUrl: string;
  /** Env var that holds the API key, if env override is desired. */
  envKeyVar: string;
  /** Default free model for this provider. */
  defaultModel: string;
  /** Catalog of free models exposed via `eyes models list`. */
  freeModels: ReadonlyArray<{ id: string; label: string; contextWindow?: number }>;
  /** Extra headers to send on every request. */
  extraHeaders?: Record<string, string>;
}

export const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  {
    id: "google-ai-studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKeyVar: "GOOGLE_AI_STUDIO_API_KEY",
    defaultModel: "gemma-4-31b-it",
    freeModels: [
      { id: "gemma-4-31b-it", label: "Gemma 4 31B (Instruction-Tuned)", contextWindow: 32_000 },
      { id: "gemma-3-27b-it", label: "Gemma 3 27B", contextWindow: 32_000 },
      { id: "gemma-3-9b-it", label: "Gemma 3 9B (fast)", contextWindow: 16_000 },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (fast, large ctx)", contextWindow: 1_000_000 },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (cheapest)", contextWindow: 1_000_000 },
    ],
  },
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKeyVar: "OPENROUTER_API_KEY",
    defaultModel: "google/gemma-3-27b-it:free",
    extraHeaders: {
      "HTTP-Referer": "https://github.com/ferre-z/eyes-mcp",
      "X-Title": "Eyes-MCP",
    },
    freeModels: [
      { id: "google/gemma-3-27b-it:free", label: "Gemma 3 27B (free)", contextWindow: 128_000 },
      { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)", contextWindow: 128_000 },
      { id: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B (free)", contextWindow: 32_000 },
      { id: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small 3.1 24B (free)", contextWindow: 32_000 },
      { id: "deepseek/deepseek-chat:free", label: "DeepSeek V3 (free)", contextWindow: 64_000 },
    ],
  },
];

export function getProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OpenAICompatibleClientOptions {
  provider: ProviderSpec;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class OpenAICompatibleClient implements LLMClient {
  public readonly model: string;
  public readonly isConfigured = true;
  public readonly providerId: ProviderSpec["id"];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: OpenAICompatibleClientOptions) {
    this.apiKey = opts.apiKey;
    this.providerId = opts.provider.id;
    this.model = opts.model ?? opts.provider.defaultModel;
    this.baseUrl = opts.provider.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.extraHeaders = opts.provider.extraHeaders ?? {};
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const wantsStructured = options.structured === true || options.responseSchema !== undefined;

    // Build OpenAI-shape request body.
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (typeof options.maxTokens === "number") body["max_tokens"] = options.maxTokens;
    if (typeof options.temperature === "number") body["temperature"] = options.temperature;

    if (options.responseSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: zodToJsonSchema(options.responseSchema),
        },
      };
    } else if (wantsStructured) {
      body["response_format"] = { type: "json_object" };
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
    };

    let res;
    try {
      res = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM request to ${this.providerId}/${this.model} failed: ${message}`);
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

    // OpenAI-shape response:
    //   { choices: [{ message: { role, content }, finish_reason }],
    //     usage: { prompt_tokens, completion_tokens } }
    const obj = parsed as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = obj.choices?.[0]?.message?.content ?? "";
    const tokensIn = obj.usage?.prompt_tokens ?? 0;
    const tokensOut = obj.usage?.completion_tokens ?? 0;

    let structured: unknown | undefined;
    if (options.responseSchema && text.length > 0) {
      try {
        const json = JSON.parse(extractJson(text));
        const result = options.responseSchema.safeParse(json);
        structured = result.success ? result.data : json;
      } catch {
        structured = undefined;
      }
    }

    return { text, tokensIn, tokensOut, structured };
  }
}

// ---------------------------------------------------------------------------
// JSON-schema converter (Zod -> JSON Schema draft-07 subset)
//
// OpenAI's response_format.json_schema needs a real JSON Schema. We convert
// just the types we actually use (string, number, boolean, enum, array,
// object) — enough for our prompts.
// ---------------------------------------------------------------------------

type JSONSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  description?: string;
};

function zodToJsonSchema(schema: z.ZodTypeAny): JSONSchema {
  let inner: z.ZodTypeAny = schema;
  while (true) {
    const def = (inner as { _def?: { typeName?: string; innerType?: z.ZodTypeAny } })._def;
    const t = def?.typeName;
    if (t === "ZodOptional" || t === "ZodNullable") {
      inner = (def as { innerType: z.ZodTypeAny }).innerType;
    } else if (t === "ZodDefault") {
      inner = (def as { innerType: z.ZodTypeAny }).innerType;
    } else {
      break;
    }
  }

  const def = (inner as { _def?: { typeName?: string; values?: readonly unknown[]; value?: unknown; shape?: () => Record<string, z.ZodTypeAny>; type?: z.ZodTypeAny; description?: string } })._def;
  const typeName = def?.typeName;
  const description = def?.description;

  switch (typeName) {
    case "ZodString": {
      const out: JSONSchema = { type: "string" };
      if (description) out.description = description;
      return out;
    }
    case "ZodNumber": {
      const out: JSONSchema = { type: "number" };
      if (description) out.description = description;
      return out;
    }
    case "ZodBoolean": {
      const out: JSONSchema = { type: "boolean" };
      if (description) out.description = description;
      return out;
    }
    case "ZodEnum": {
      const values = (def as { values: readonly [string, ...string[]] }).values;
      const out: JSONSchema = { type: "string", enum: [...values] };
      if (description) out.description = description;
      return out;
    }
    case "ZodLiteral": {
      const v = (def as { value: unknown }).value;
      if (typeof v === "string") return { type: "string", enum: [v] };
      if (typeof v === "number") return { type: "number" };
      if (typeof v === "boolean") return { type: "boolean" };
      throw new Error(`zodToJsonSchema: unsupported literal`);
    }
    case "ZodArray": {
      const elementType = (def as { type: z.ZodTypeAny }).type;
      const out: JSONSchema = { type: "array", items: zodToJsonSchema(elementType) };
      if (description) out.description = description;
      return out;
    }
    case "ZodObject": {
      const shapeFn = (def as { shape: () => Record<string, z.ZodTypeAny> }).shape;
      const shape = typeof shapeFn === "function" ? shapeFn() : shapeFn;
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(shape)) {
        const child = zodToJsonSchema(sub);
        const childDef = (sub as { _def?: { typeName?: string } })._def;
        const childType = childDef?.typeName;
        const isOptional =
          childType === "ZodOptional" || childType === "ZodNullable" || childType === "ZodDefault";
        properties[key] = child;
        if (!isOptional) required.push(key);
      }
      const out: JSONSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      if (description) out.description = description;
      return out;
    }
    default:
      throw new Error(
        `zodToJsonSchema: unsupported Zod type "${String(typeName)}". Supported: string, number, boolean, enum, array, object.`,
      );
  }
}

/** Strip markdown code fences from an LLM response. */
function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("```")) {
    const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(t);
    if (m) return m[1] ?? "";
  }
  return t;
}

// ---------------------------------------------------------------------------
// Backward-compat shim
//
// The old code created `GeminiClient` directly. We keep that class name as
// a thin alias so `src/cli/chat.ts` and `src/llm/gemini.ts`'s own callers
// keep working.
// ---------------------------------------------------------------------------

export { OpenAICompatibleClient as GeminiClient };
