// =============================================================================
// Eyes-MCP — parse layer 2: chunk.
//
// Reads the raw shard artifacts (or, if available, the stripped text
// layer 1 wrote) and turns them into a ParsedShard: a 1-2 sentence
// summary plus a list of deduped, capped chunks the main agent can
// review and synthesize over.
//
// No LLM, no network. Pure local string transforms + a simhash dedup.
// =============================================================================

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "winston";
import type { Chunk, ParsedShard, SourceCategory, Depth } from "../dispatcher/types.js";
import { approximateTokens, collapseWhitespace, extractFirstUrl, splitParagraphs, splitSentences } from "./text.js";
import { hamming, simhash, tokenize } from "./simhash.js";

/** Mirror of strip.ts — same logger surface, same name. */
export type LoggerLike = Pick<Logger, "info" | "warn" | "error" | "debug">;

export interface ChunkOptions {
  depth: Depth;
  dataDir: string;
  maxChunksPerShard: number;
  logger?: LoggerLike;
}

type RawResult = { shardId: string; ok: boolean; rawPath?: string; error?: string };

/** SourceId (as written by adapters) → SourceCategory (what the main agent sees). */
function sourceIdToCategory(source: string): SourceCategory {
  switch (source) {
    case "github":
      return "github";
    case "reddit":
      return "reddit";
    case "youtube":
      return "youtube";
    case "hackernews":
      return "hackernews";
    case "arxiv":
      return "arxiv";
    case "wikipedia":
      return "wikipedia";
    case "searxng":
    case "crawl4ai":
    case "osm":
    case "generic":
    default:
      return "web";
  }
}

/**
 * Run the chunk layer on every shard. For each successful shard we read
 * the raw artifact, prefer the stripped text layer 1 wrote, and emit a
 * ParsedShard. Failed shards get a zero-chunk ParsedShard with a
 * descriptive summary.
 */
export async function chunkShards(
  shardResults: ReadonlyArray<RawResult>,
  opts: ChunkOptions,
): Promise<ParsedShard[]> {
  const log = opts.logger;
  const strippedDir = path.join(opts.dataDir, "shards");
  // Make sure the directory exists so we can stat the stripped files.
  await mkdir(strippedDir, { recursive: true });

  const out: ParsedShard[] = [];
  for (const r of shardResults) {
    if (!r.ok || !r.rawPath) {
      out.push(failedShard(r));
      continue;
    }
    try {
      const raw = await readFile(r.rawPath, "utf8");
      const strippedPath = path.join(strippedDir, `${r.shardId}.stripped.txt`);
      const text = await readStrippedOrFallback(strippedPath, raw);

      // Pull source + url out of the raw artifact.
      const meta = extractMeta(raw);
      const category = sourceIdToCategory(meta.source);

      const chunks = buildChunks(text, meta.firstUrl, opts.maxChunksPerShard, log, r.shardId);
      const summary = makeSummary(chunks);
      out.push({
        shardId: r.shardId,
        source: category,
        summary,
        chunks,
      });
      log?.debug("chunk: shard done", {
        shardId: r.shardId,
        source: meta.source,
        category,
        chunks: chunks.length,
      });
    } catch (err) {
      log?.warn("chunk: shard failed", {
        shardId: r.shardId,
        err: err instanceof Error ? err.message : String(err),
      });
      out.push(failedShard(r, "chunk"));
    }
  }
  return out;
}

/** Read the stripped text file; if it doesn't exist, fall back to the raw artifact. */
async function readStrippedOrFallback(strippedPath: string, rawArtifact: string): Promise<string> {
  try {
    return await readFile(strippedPath, "utf8");
  } catch {
    return rawArtifact;
  }
}

interface ShardMeta {
  source: string;
  firstUrl: string | undefined;
}

function extractMeta(rawArtifact: string): ShardMeta {
  let source = "searxng"; // best guess for the common case
  let firstUrl: string | undefined;
  try {
    const obj = JSON.parse(rawArtifact) as Record<string, unknown> | null;
    if (obj && typeof obj === "object") {
      const s = obj["source"];
      if (typeof s === "string") source = s;
      const payload = obj["payload"];
      // SearXNG-style: payload.results: Array<{url}>
      if (payload && typeof payload === "object") {
        const results = (payload as Record<string, unknown>)["results"];
        if (Array.isArray(results) && results.length > 0) {
          const first = results[0] as Record<string, unknown> | undefined;
          if (first && typeof first["url"] === "string") {
            firstUrl = first["url"] as string;
          }
        }
      }
    }
  } catch {
    // Treat unparseable raw as web/search; try to scrape a URL out of the text.
  }
  if (!firstUrl) {
    firstUrl = extractFirstUrl(rawArtifact);
  }
  return { source, firstUrl };
}

/**
 * Split the text into paragraphs, preserve markdown code blocks as their
 * own chunks, split oversized paragraphs by sentence, then dedupe with
 * simhash. The charOffset is the position in the *original* cleaned
 * text (a best-effort — we don't need it to be exact, the main agent
 * uses it only for citations).
 */
function buildChunks(
  text: string,
  defaultUrl: string | undefined,
  maxChunksPerShard: number,
  log: LoggerLike | undefined,
  shardId: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  if (!text || text.trim().length === 0) return chunks;

  // Split on blank-line paragraph boundaries first.
  const paragraphs = splitParagraphs(text);

  // Pre-compute the offset of every paragraph start in the original text
  // so chunks can report where in the source they came from.
  const paragraphOffsets: number[] = [];
  {
    let cursor = 0;
    for (const p of paragraphs) {
      const idx = text.indexOf(p, cursor);
      paragraphOffsets.push(idx === -1 ? cursor : idx);
      cursor = (idx === -1 ? cursor : idx) + p.length;
    }
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i] ?? "";
    const paraOffset = paragraphOffsets[i] ?? 0;
    const codeChunks = extractCodeBlocks(para);
    if (codeChunks.length > 0) {
      for (const c of codeChunks) {
        const url = extractFirstUrl(c) ?? defaultUrl;
        const chunk: Chunk = {
          text: c,
          ...(url ? { url } : {}),
          charOffset: paraOffset,
          tokenCount: approximateTokens(c),
        };
        chunks.push(chunk);
      }
      continue;
    }
    const tokens = approximateTokens(para);
    if (tokens > 500) {
      // Split oversized paragraph by sentence.
      const sentences = splitSentences(para);
      let sentCursor = 0;
      for (const sent of sentences) {
        const sentOffset = text.indexOf(sent, sentCursor);
        if (sentOffset >= 0) sentCursor = sentOffset + sent.length;
        const url = extractFirstUrl(sent) ?? defaultUrl;
        const chunk: Chunk = {
          text: sent,
          ...(url ? { url } : {}),
          charOffset: sentOffset >= 0 ? sentOffset : paraOffset,
          tokenCount: approximateTokens(sent),
        };
        chunks.push(chunk);
      }
    } else {
      const url = extractFirstUrl(para) ?? defaultUrl;
      const chunk: Chunk = {
        text: para,
        ...(url ? { url } : {}),
        charOffset: paraOffset,
        tokenCount: tokens,
      };
      chunks.push(chunk);
    }
  }

  // Dedup with simhash; hamming < 5 collapses to a single chunk.
  const accepted: Chunk[] = [];
  const acceptedHashes: bigint[] = [];
  let dropped = 0;
  for (const c of chunks) {
    const tokens = tokenize(c.text);
    if (tokens.length === 0) continue;
    const hash = simhash(tokens);
    let isDup = false;
    for (const h of acceptedHashes) {
      if (hamming(h, hash) < 5) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      dropped++;
      continue;
    }
    accepted.push(c);
    acceptedHashes.push(hash);
    if (accepted.length >= maxChunksPerShard) break;
  }
  if (dropped > 0) {
    log?.debug("chunk: dedup dropped chunks", { shardId, dropped, kept: accepted.length });
  }
  return accepted;
}

/**
 * Pull markdown code blocks (```...```) out of a paragraph. If a
 * paragraph contains at least one fenced block, return each block as
 * its own chunk and skip the surrounding prose.
 */
function extractCodeBlocks(para: string): string[] {
  const out: string[] = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(para)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/** Build the 1-2 sentence summary the main agent sees. */
function makeSummary(chunks: Chunk[]): string {
  if (chunks.length === 0) return "";
  const first = chunks[0]?.text ?? "";
  const trimmed = collapseWhitespace(first).slice(0, 200);
  return trimmed;
}

function failedShard(r: RawResult, _phase?: "strip" | "chunk"): ParsedShard {
  return {
    shardId: r.shardId,
    source: "web",
    summary: r.error ? `Shard failed: ${r.error}` : "Shard produced no output.",
    chunks: [],
  };
}
