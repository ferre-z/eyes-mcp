// =============================================================================
// Eyes-MCP — SearXNG adapter (web meta-search)
//
// Calls our local SearXNG instance (configured via SEARXNG_URL, default
// http://searxng:8080). Returns the top N results as JSON. The parse layer
// turns the result list into chunks (title + url + snippet per result).
//
// Auth: none (SearXNG is a meta-search engine we own).
// Rate limit: none we enforce — SearXNG has its own internal limits.
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchJson, AdapterError, shardIdFromOutPath } from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESULTS = 10;
const MAX_RESULTS = 50; // SearXNG hard cap

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  category?: string;
  score?: number;
  publishedDate?: string | null;
}

interface SearxngResponse {
  results: SearxngResult[];
  query?: string;
  number_of_results?: number;
}

/** Public: build the ShardAdapter so the dispatcher can use it. */
export const searxngAdapter: ShardAdapter = {
  category: "web",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const base = (process.env["SEARXNG_URL"] ?? "http://searxng:8080").replace(/\/$/, "");
    const limit = clampLimit(
      Number.parseInt(process.env["SEARXNG_RESULTS"] ?? "", 10) || DEFAULT_RESULTS,
    );

    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en-US&safesearch=0`;
    const data = await httpFetchJson<SearxngResponse>(url, {
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const results = Array.isArray(data.results) ? data.results.slice(0, limit) : [];

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "searxng",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        total: data.number_of_results ?? results.length,
        engines: dedupe(results.map((r) => r.engine ?? "unknown")).slice(0, 10),
        results: results.map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.content ?? "",
          engine: r.engine ?? "unknown",
          score: r.score ?? 0,
          publishedDate: r.publishedDate ?? null,
        })),
      },
    };

    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

function clampLimit(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

function dedupe<T>(arr: ReadonlyArray<T>): T[] {
  return Array.from(new Set(arr));
}

// Exported for tests
export const __internal = { clampLimit };

// Silence unused-import warning if AdapterError isn't used directly.
void AdapterError;
