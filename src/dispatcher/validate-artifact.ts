// =============================================================================
// Eyes-MCP — soft artifact validation
//
// Validates the shape of a raw shard artifact at the dispatcher boundary.
// We chose the "soft" path: a malformed artifact is logged as a warning
// but does NOT fail the shard. The reasoning:
//   * The chunk layer is permissive and produces a useful (if degraded)
//     ParsedShard even from weird input.
//   * Failing shards during a transient upstream change (e.g. a SearXNG
//     instance that added a new field) would break every running query.
//   * The warning shows up in operator logs, so the bug surfaces for
//     fixing without breaking the user.
//
// A future v0.2 could promote this to strict (fail the shard) by default
// with an opt-out env var.
// =============================================================================

import { readFile } from "node:fs/promises";
import type { LoggerLike } from "../parse/chunk.js";

/** Known source ids in the SourceId enum (src/adapters/types.ts). */
const KNOWN_SOURCE_IDS = new Set([
  "searxng",
  "crawl4ai",
  "github",
  "reddit",
  "youtube",
  "hackernews",
  "arxiv",
  "wikipedia",
  "osm",
  "generic",
]);

/** Required top-level fields for a well-formed artifact. */
const REQUIRED_TOP_LEVEL = ["shardId", "source", "fetchedAt"] as const;

export interface ValidationResult {
  ok: boolean;
  /** When ok=false, a one-line reason. */
  reason?: string;
}

/**
 * Read the artifact at `path` and check it has the expected envelope
 * shape. Never throws; returns `{ ok: false, reason }` on any problem.
 */
export async function validateRawArtifact(path: string): Promise<ValidationResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, reason: "top-level is not an object" };
  }
  const rec = obj as Record<string, unknown>;

  for (const key of REQUIRED_TOP_LEVEL) {
    if (typeof rec[key] !== "string" || (rec[key] as string).length === 0) {
      return { ok: false, reason: `missing or empty top-level field "${key}"` };
    }
  }
  const source = rec["source"] as string;
  if (!KNOWN_SOURCE_IDS.has(source)) {
    return { ok: false, reason: `unknown source id "${source}"` };
  }
  if (!("payload" in rec)) {
    return { ok: false, reason: 'missing top-level "payload" field' };
  }
  return { ok: true };
}

/**
 * Validate and log a warning on failure. Returns the validation result
 * so callers can branch on it. Logging is the only side effect; we
 * deliberately do NOT throw or fail the shard.
 */
export async function validateAndLog(
  path: string,
  shardId: string,
  logger: LoggerLike | undefined,
): Promise<ValidationResult> {
  const result = await validateRawArtifact(path);
  if (!result.ok) {
    logger?.warn("dispatcher: artifact shape is unexpected (keeping shard as ok=true)", {
      shardId,
      path,
      reason: result.reason,
    });
  }
  return result;
}
