// =============================================================================
// Eyes-MCP — generic (URL → markdown) adapter
//
// "Anything else" fallback. Treats the shard query as a single URL and
// pushes it through the local Crawl4AI service to get a clean markdown
// blob. Used for shards where the agent flagged an arbitrary page that
// no specialized adapter covers.
//
// Note: this is the same fetch service that the dedicated `crawl4ai`
// adapter wraps, but the source id on disk is "generic" (so the parse
// layer / dispatcher can tell them apart when debugging).
//
// If the query is not a URL, we throw AdapterError("not_found"). The
// dispatcher should only route raw URL queries here.
// =============================================================================

import { writeFile } from "node:fs/promises";
import {
  AdapterError,
  httpFetchJson,
  shardIdFromOutPath,
} from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface Crawl4AIRequest {
  urls: string[];
  extraction_config?: { type: "markdown" | "json" | string };
  priority?: number;
}

interface Crawl4AIResult {
  url?: string;
  success?: boolean;
  markdown?: { raw_markdown?: string; markdown_with_citations?: string };
  error?: string;
}

interface Crawl4AIResponse {
  success?: boolean;
  results?: Crawl4AIResult[];
  error?: string;
}

export const genericAdapter: ShardAdapter = {
  category: "web",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const target = query.trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new AdapterError(
        "generic: query is not a URL",
        "not_found",
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
      throw new AdapterError(`generic: ${msg}`, "other", { url: target });
    }
    const markdown =
      first.markdown?.raw_markdown ?? first.markdown?.markdown_with_citations ?? "";
    if (markdown.length === 0) {
      throw new AdapterError(`generic: empty markdown for ${target}`, "parse", {
        url: target,
      });
    }

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "generic",
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
