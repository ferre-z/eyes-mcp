// =============================================================================
// Eyes-MCP — Crawl4AI adapter
//
// "Fetch this URL and give me markdown." Crawl4AI is a local service
// (configured via CRAWL4AI_URL, default http://crawl4ai:11235) that we own.
//
// We support two modes:
//   1. Direct URL fetch — shard.query IS a URL.
//   2. Query → URL resolution — the heuristic passed us a search term, we
//      try to extract a URL. If none, we throw and let the dispatcher
//      mark the shard failed; the user should use searxng for queries.
//
// The output is the page rendered as markdown. Large pages are stored as-is;
// the parse layer chunks them.
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchJson, AdapterError, shardIdFromOutPath } from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface Crawl4AIRequest {
  urls: string[];
  /** "markdown" gives us a single cleaned-up markdown blob. */
  extraction_config?: { type: "markdown" | "json" | string };
  /** Be polite; default 1. */
  priority?: number;
}

interface Crawl4AIResult {
  url?: string;
  success?: boolean;
  markdown?: { raw_markdown?: string; markdown_with_citations?: string };
  cleaned_html?: string;
  error?: string;
}

interface Crawl4AIResponse {
  success?: boolean;
  results?: Crawl4AIResult[];
  error?: string;
}

export const crawl4aiAdapter: ShardAdapter = {
  category: "web",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const target = extractUrl(query);
    if (!target) {
      throw new AdapterError(
        `crawl4ai: shard query "${query}" is not a URL; use searxng for non-URL queries`,
        "other",
        { url: query },
      );
    }

    const base = (process.env["CRAWL4AI_URL"] ?? "http://crawl4ai:11235").replace(/\/$/, "");
    const body: Crawl4AIRequest = {
      urls: [target],
      extraction_config: { type: "markdown" },
      priority: 1,
    };

    const data = await httpFetchJson<Crawl4AIResponse>(`${base}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const first = data.results?.[0];
    if (!first || first.success === false) {
      const msg = first?.error ?? data.error ?? "no result from crawl4ai";
      throw new AdapterError(`crawl4ai: ${msg}`, "other", { url: target });
    }
    const markdown = first.markdown?.raw_markdown ?? first.markdown?.markdown_with_citations ?? "";
    if (markdown.length === 0) {
      throw new AdapterError(`crawl4ai: empty markdown for ${target}`, "parse", { url: target });
    }

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "crawl4ai",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        url: first.url ?? target,
        markdown,
        bytes: markdown.length,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

function extractUrl(s: string): string | null {
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}
