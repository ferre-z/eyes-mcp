// =============================================================================
// Eyes-MCP — shared HTTP fetch wrapper for adapters
//
// Every adapter goes through this. Responsibilities:
//   * Apply a per-call timeout (default 15s, callers can override)
//   * Set a User-Agent (most sites reject requests without one)
//   * Normalize non-2xx responses into AdapterError with an errorKind
//   * Provide a JSON variant that validates the response shape
//
// The wrapper deliberately uses the built-in `fetch` from undici (Node 20+)
// so we don't pull in another HTTP client.
// =============================================================================

import { basename, extname } from "node:path";
import { logger as rootLogger } from "../util/logger.js";
import type { Logger } from "winston";

/** Extract the shard id (filename minus extension) from a dispatch outPath. */
export function shardIdFromOutPath(outPath: string): string {
  const base = basename(outPath, extname(outPath));
  return base || "unknown";
}

/** Default User-Agent. Override per-adapter if the site demands a specific one. */
export const DEFAULT_USER_AGENT = "eyes-mcp/0.1 (+https://github.com/eyes-mcp/Eyes-MCP)";

/** Categories of failure the dispatcher and parse layer can branch on. */
export type AdapterErrorKind =
  | "timeout"
  | "rate_limit"
  | "blocked"
  | "not_found"
  | "parse"
  | "other";

/** Structured error thrown by adapters. Always has an `errorKind`. */
export class AdapterError extends Error {
  public readonly errorKind: AdapterErrorKind;
  public readonly status: number | undefined;
  public readonly url: string;
  constructor(
    message: string,
    errorKind: AdapterErrorKind,
    opts: { status?: number; url?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AdapterError";
    this.errorKind = errorKind;
    this.status = opts.status;
    this.url = opts.url ?? "<unknown>";
    if (opts.cause !== undefined) {
      // Preserve the cause in modern JS without requiring Node 18+ polyfills.
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

export interface HttpFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | URLSearchParams | undefined;
  /** Timeout in ms. Default 15_000. */
  timeoutMs?: number;
  /** User-Agent. Default eyes-mcp/0.1. */
  userAgent?: string;
  /** Optional per-call logger. Falls back to rootLogger. */
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug">;
  /** Extra signal to abort on. */
  signal?: AbortSignal;
}

/**
 * Single-internal fetch wrapper used by every adapter.
 *
 * Returns the Response object on success. On non-2xx, throws AdapterError
 * with a categorized errorKind so the dispatcher can branch on it.
 */
export async function httpFetch(url: string, opts: HttpFetchOptions = {}): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 15_000,
    userAgent = DEFAULT_USER_AGENT,
    logger,
    signal,
  } = opts;

  // Combine external signal + timeout into one AbortController.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mergedHeaders: Record<string, string> = {
    "User-Agent": userAgent,
    Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
    ...headers,
  };

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: mergedHeaders,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = controller.signal.aborted;
      if (isAbort) {
        if (signal?.aborted) {
          throw new AdapterError("request aborted by caller", "other", { url });
        }
        throw new AdapterError(`request timed out after ${timeoutMs}ms`, "timeout", { url, cause: err });
      }
      throw new AdapterError(
        `network error: ${err instanceof Error ? err.message : String(err)}`,
        "other",
        { url, cause: err },
      );
    }

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      // Try to grab a short body snippet for the error message.
      let snippet = "";
      try {
        const text = await response.text();
        snippet = text.slice(0, 240);
      } catch {
        // ignore
      }
      logger?.debug("httpFetch: non-2xx", { url, status: response.status, kind, snippet });
      throw new AdapterError(
        `HTTP ${response.status} from ${url}: ${snippet}`,
        kind,
        { status: response.status, url },
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Convenience: fetch + parse JSON. Throws AdapterError("parse") on bad JSON. */
export async function httpFetchJson<T>(url: string, opts: HttpFetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, opts);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new AdapterError(
      `invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "parse",
      { url, cause: err },
    );
  }
}

/** Convenience: fetch + return text. */
export async function httpFetchText(url: string, opts: HttpFetchOptions = {}): Promise<string> {
  const res = await httpFetch(url, opts);
  return res.text();
}

/** Map an HTTP status to an errorKind. Centralized so all adapters agree. */
function classifyStatus(status: number): AdapterErrorKind {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 403) return "blocked";
  if (status === 408) return "timeout";
  if (status >= 500 && status < 600) return "other";
  if (status >= 400 && status < 500) return "blocked";
  return "other";
}

/** Reference to the root logger for adapters that don't get one injected. */
export { rootLogger };
