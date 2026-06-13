// =============================================================================
// Eyes-MCP — parse layer 1: strip.
//
// Reads each raw shard artifact the dispatcher wrote, strips it to plain
// text according to the requested depth, and writes the result to
// `${dataDir}/shards/{shardId}.stripped.txt`. Layer 2 (chunk.ts) consumes
// those stripped files.
//
// No LLM, no network. Pure local string transforms.
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "winston";
import type { Depth } from "../dispatcher/types.js";
import { collapseWhitespace, splitSentences } from "./text.js";
import { summarizeArtifact } from "./summarize.js";

/** Shape subagent C uses everywhere else for an injected logger. */
export type LoggerLike = Pick<Logger, "info" | "warn" | "error" | "debug">;

export interface StripOptions {
  depth: Depth;
  dataDir: string;
  logger?: LoggerLike;
}

export interface StripResult {
  shardId: string;
  cleanedPath: string;
  bytesIn: number;
  bytesOut: number;
  droppedRatio: number;
}

const NAV_FOOTER_REGEX =
  /\b(navigation|skip to main|all rights reserved|privacy policy|terms of service|cookie policy)\b/i;

/**
 * Run the strip layer on every shard. Successful shards are written to
 * `${dataDir}/shards/{shardId}.stripped.txt`. Failed shards return a
 * zero-stat record so downstream code can keep going.
 */
export async function stripShards(
  shardResults: ReadonlyArray<{ shardId: string; ok: boolean; rawPath?: string; error?: string }>,
  opts: StripOptions,
): Promise<StripResult[]> {
  const log = opts.logger;
  const outDir = path.join(opts.dataDir, "shards");
  await mkdir(outDir, { recursive: true });

  const results: StripResult[] = [];
  for (const r of shardResults) {
    if (!r.ok || !r.rawPath) {
      results.push({
        shardId: r.shardId,
        cleanedPath: "",
        bytesIn: 0,
        bytesOut: 0,
        droppedRatio: 0,
      });
      continue;
    }

    try {
      const raw = await readFile(r.rawPath, "utf8");
      const bytesIn = Buffer.byteLength(raw, "utf8");
      const cleaned = stripByDepth(raw, opts.depth);
      const cleanedPath = path.join(outDir, `${r.shardId}.stripped.txt`);
      await writeFile(cleanedPath, cleaned, "utf8");
      const bytesOut = Buffer.byteLength(cleaned, "utf8");
      const droppedRatio = bytesIn > 0 ? 1 - bytesOut / bytesIn : 0;
      results.push({
        shardId: r.shardId,
        cleanedPath,
        bytesIn,
        bytesOut,
        droppedRatio,
      });
      log?.debug("strip: shard done", {
        shardId: r.shardId,
        depth: opts.depth,
        bytesIn,
        bytesOut,
        droppedRatio,
      });
    } catch (err) {
      log?.warn("strip: shard failed", {
        shardId: r.shardId,
        err: err instanceof Error ? err.message : String(err),
      });
      results.push({
        shardId: r.shardId,
        cleanedPath: "",
        bytesIn: 0,
        bytesOut: 0,
        droppedRatio: 0,
      });
    }
  }
  return results;
}

/**
 * Run the per-depth strip pipeline on a single raw artifact body.
 * Always returns a plain-text string (no HTML, no JSON braces from
 * the original artifact).
 */
function stripByDepth(raw: string, depth: Depth): string {
  // Step 0: turn the JSON artifact into a more text-friendly form. Each
  // adapter has a registered summarizer that knows the shape of its
  // payload; this produces a markdown-ish string with real paragraph
  // structure (so the chunk layer's per-paragraph dedup actually has
  // something to dedup). Unknown sources fall back to a generic
  // JSON-stringify dumper.
  let text = summarizeArtifact(raw);

  if (depth === "quick") {
    return text;
  }

  // standard: drop nav/footer-like lines + blank lines.
  text = dropNavFooter(text);

  if (depth === "standard") {
    return text;
  }

  // deep: also drop sentences that appear > 3 times in this shard.
  text = dedupFrequentSentences(text);
  return text;
}

/** One object's worth of text, formatted as "key: value" lines. */
function flattenObject(o: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`${k}: ${String(v)}`);
    } else if (Array.isArray(v)) {
      const inner = v
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join(" | ");
      if (inner) lines.push(`${k}: ${inner}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

/** Drop lines that look like nav/footer boilerplate. Preserves blank lines
 * (which the chunk layer relies on as paragraph separators). */
function dropNavFooter(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      // Collapse runs of blank lines to a single blank — keep paragraph
      // structure but don't waste a 5KB artifact on 200 blank lines.
      if (kept.length > 0 && kept[kept.length - 1] === "") continue;
      kept.push("");
      continue;
    }
    if (NAV_FOOTER_REGEX.test(line)) continue;
    kept.push(line);
  }
  // Strip trailing blank lines so the chunk layer doesn't see a phantom
  // empty paragraph at the end.
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/**
 * Drop sentences that appear more than 3 times in this shard. Cheap
 * in-memory frequency map; we dedupe at the sentence level.
 */
function dedupFrequentSentences(text: string): string {
  const sentences = splitSentences(text);
  const counts = new Map<string, number>();
  for (const s of sentences) {
    const key = s.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const s of sentences) {
    const key = s.toLowerCase().replace(/\s+/g, " ").trim();
    const c = counts.get(key) ?? 0;
    if (c > 3) continue;
    // Also avoid emitting the same near-blank sentence twice.
    if (collapseWhitespace(s) === "") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }
  return kept.join(" ");
}
