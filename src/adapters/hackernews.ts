// =============================================================================
// Eyes-MCP — Hacker News adapter
//
// Uses Algolia's HN Search API: https://hn.algolia.com/api/v1/search
// No auth. No rate limit (within reason).
//
// One mode: free-text query → top hits with metadata.
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchJson, shardIdFromOutPath } from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HITS = 20;

interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  story_title?: string | null;
  url?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  points?: number | null;
  num_comments?: number | null;
  author?: string;
  created_at?: string;
  created_at_i?: number;
  _tags?: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits?: number;
  page?: number;
  hitsPerPage?: number;
  query?: string;
}

export const hackernewsAdapter: ShardAdapter = {
  category: "hackernews",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const hits = Math.min(50, DEFAULT_HITS);
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${hits}&tags=story`;

    const data = await httpFetchJson<AlgoliaResponse>(url, {
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const items = (data.hits ?? []).map((h) => {
      const title = h.title ?? h.story_title ?? "(untitled)";
      const url = h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`;
      return {
        objectID: h.objectID,
        title,
        url,
        points: h.points ?? 0,
        numComments: h.num_comments ?? 0,
        author: h.author ?? "unknown",
        createdAt: h.created_at ?? new Date((h.created_at_i ?? 0) * 1000).toISOString(),
        text: h.story_text ?? null,
      };
    });

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "hackernews",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        total: data.nbHits ?? items.length,
        items,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};
