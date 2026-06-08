// =============================================================================
// Eyes-MCP — LLM client interface
//
// The main agent depends on this interface, not on Gemini directly, so we
// can swap implementations (heuristic-only, real Gemini, mock for tests) and
// so the main-agent code is testable without hitting the network.
// =============================================================================

import type { ZodTypeAny } from "zod";

/** Per-call overrides. */
export interface GenerateOptions {
  /** Zod schema to force structured JSON output from the model. */
  responseSchema?: ZodTypeAny;
  /** Cap output tokens. Provider default if omitted. */
  maxTokens?: number;
  /** 0.0–1.0. Default 0.2 (low — we want deterministic JSON). */
  temperature?: number;
  /** Convenience: hint the model to return JSON. Implied if responseSchema set. */
  structured?: boolean;
  /** System prompt prepended to the user prompt. */
  system?: string;
}

export interface GenerateResult {
  /** Best-effort text the model produced. */
  text: string;
  tokensIn: number;
  tokensOut: number;
  /**
   * If the call was structured and we successfully parsed, this holds the
   * parsed value matching the Zod schema. Undefined otherwise.
   */
  structured?: unknown;
}

/** Thrown when an API key is missing — callers fall back to heuristic mode. */
export class MissingApiKeyError extends Error {
  constructor(envVar: string) {
    super(
      `${envVar} is not set — LLM features disabled. ` +
        `Set the env var to enable the main agent's LLM mode, or accept heuristic mode.`,
    );
    this.name = "MissingApiKeyError";
  }
}

/** Thrown when the model returns an unrecoverable error (e.g. 4xx/5xx). */
export class LlmHttpError extends Error {
  public readonly status: number;
  public readonly body: string;
  constructor(status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface LLMClient {
  /** True if this client is configured and can actually make calls. */
  readonly isConfigured: boolean;
  /** Model name (informational, surfaced in logs). */
  readonly model: string;
  /**
   * Run a single completion. May throw MissingApiKeyError, LlmHttpError,
   * or any underlying network error. Callers should handle each.
   */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}
