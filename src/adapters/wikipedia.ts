// =============================================================================
// Eyes-MCP — Wikipedia adapter
//
// Two-step:
//   1. MediaWiki action API search: returns top N titles for the query.
//   2. For the top title, fetch the REST summary (no auth, no rate limit).
//
// Both endpoints are public. The summary endpoint is what we hand to the
// parse layer; it has a clean extract (plain text, ~1-3 paragraphs).
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchJson, shardIdFromOutPath } from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HITS = 5;
const MAX_HITS = 10;

interface MediaWikiSearchHit {
  title: string;
  pageid: number;
  snippet?: string;
  size?: number;
  wordcount?: number;
}

interface MediaWikiSearchResponse {
  query?: { search?: MediaWikiSearchHit[] };
}

interface WikiSummary {
  type?: string;
  title?: string;
  displaytitle?: string;
  description?: string;
  extract?: string;
  extract_html?: string;
  content_urls?: { desktop?: { page?: string }; mobile?: { page?: string } };
  thumbnail?: { source?: string; width?: number; height?: number };
  lang?: string;
  timestamp?: string;
}

export const wikipediaAdapter: ShardAdapter = {
  category: "wikipedia",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const limit = clampMax(
      Number.parseInt(process.env["WIKIPEDIA_HITS"] ?? "", 10) || DEFAULT_HITS,
    );
    const lang = process.env["WIKIPEDIA_LANG"] ?? "en";

    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&utf8=1&origin=*`;
    const searchData = await httpFetchJson<MediaWikiSearchResponse>(searchUrl, {
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const hits = (searchData.query?.search ?? []).map((h) => ({
      title: h.title,
      pageid: h.pageid,
      snippet: stripHtml(h.snippet ?? ""),
    }));

    // For each top hit, fetch the summary. Run them sequentially — Wikipedia
    // is fast and we don't want to be impolite.
    const summaries: WikiSummary[] = [];
    for (const h of hits.slice(0, Math.min(3, hits.length))) {
      const summary = await fetchSummary(h.title, lang, timeoutMs || DEFAULT_TIMEOUT_MS);
      if (summary) summaries.push(summary);
    }

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "wikipedia",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        total: hits.length,
        hits,
        summaries,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

async function fetchSummary(
  title: string,
  lang: string,
  timeoutMs: number,
): Promise<WikiSummary | null> {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  try {
    return await httpFetchJson<WikiSummary>(url, { timeoutMs });
  } catch {
    return null;
  }
}

function clampMax(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_HITS;
  return Math.max(1, Math.min(MAX_HITS, Math.floor(n)));
}

/** Wikipedia's snippet field contains <span> highlights; strip them. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}
