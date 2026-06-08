// =============================================================================
// Eyes-MCP — Reddit adapter
//
// Uses Reddit's public JSON endpoints (no auth). Reddit rejects requests
// without a custom User-Agent, so we override the default. If `hint` looks
// like a subreddit, we restrict the search to it; otherwise we search all.
//
// After listing the top 5 hits, we follow each permalink to fetch the
// comment thread (top 3 comments per thread).
//
// Rate limit: 60 req/hr conservative — Reddit's unauth limit is technically
// 100 req/min, but we share an IP across many agents.
// =============================================================================

import { writeFile } from "node:fs/promises";
import {
  AdapterError,
  httpFetchJson,
  shardIdFromOutPath,
} from "./http.js";
import { createBucket } from "./rate-limit.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const SUBREDDIT_HINT_RE = /^(?:r\/)?([a-z0-9_]{2,21})$/i;

const bucket = createBucket({ capacity: 60, refillPerSec: 60 / 3600 });

interface RedditListingChild<T> {
  kind?: string;
  data?: T;
}

interface RedditPost {
  id?: string;
  title?: string;
  url?: string;
  subreddit?: string;
  score?: number;
  num_comments?: number;
  permalink?: string;
  selftext?: string;
  created_utc?: number;
  author?: string;
  over_18?: boolean;
}

interface RedditComment {
  id?: string;
  body?: string;
  author?: string;
  score?: number;
  created_utc?: number;
}

interface RedditListingResponse<T> {
  data?: { children?: RedditListingChild<T>[]; after?: string | null };
}

/** Extract a subreddit name from a hint. Returns null if it doesn't look like one. */
function subredditFromHint(hint: string | undefined): string | null {
  if (!hint) return null;
  const m = SUBREDDIT_HINT_RE.exec(hint.trim());
  if (!m || !m[1]) return null;
  return m[1].toLowerCase();
}

export const redditAdapter: ShardAdapter = {
  category: "reddit",

  async search(query, hint, _depth, outPath, timeoutMs): Promise<void> {
    await bucket.take();

    const sub = subredditFromHint(hint);
    const searchUrl = sub
      ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(
          query,
        )}&restrict_sr=on&limit=10&sort=relevance&t=week`
      : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=10&sort=relevance&t=week`;

    const headers = { "User-Agent": "eyes-mcp/0.1 (research)" };
    let listing: RedditListingResponse<RedditPost>;
    try {
      listing = await httpFetchJson<RedditListingResponse<RedditPost>>(searchUrl, {
        headers,
        timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(
        `reddit: search failed: ${err instanceof Error ? err.message : String(err)}`,
        "other",
        { url: searchUrl, cause: err },
      );
    }

    const posts = (listing.data?.children ?? [])
      .map((c) => c.data)
      .filter((d): d is RedditPost => d !== undefined)
      .slice(0, 5);

    // Pull comment threads for the top 5.
    const enriched = await Promise.all(
      posts.map(async (p) => {
        const comments = await fetchTopComments(p.permalink ?? "", headers, timeoutMs);
        return {
          id: p.id ?? "",
          title: p.title ?? "",
          url: p.url ?? "",
          subreddit: p.subreddit ?? "",
          author: p.author ?? "",
          score: p.score ?? 0,
          num_comments: p.num_comments ?? 0,
          permalink: p.permalink ?? "",
          selftext: p.selftext ?? "",
          created_utc: p.created_utc ?? 0,
          over_18: p.over_18 ?? false,
          top_comments: comments,
        };
      }),
    );

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "reddit",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        subreddit: sub,
        total: enriched.length,
        posts: enriched,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

async function fetchTopComments(
  permalink: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RedditComment[]> {
  if (!permalink) return [];
  const url = `https://www.reddit.com${permalink}.json?limit=3&sort=top`;
  try {
    const res = await httpFetchJson<RedditListingResponse<RedditComment>[]>(url, {
      headers,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    // The response is a 2-element array: [postListing, commentsListing].
    const commentsListing = res[1];
    const children = commentsListing?.data?.children ?? [];
    return children
      .map((c) => c.data)
      .filter((d): d is RedditComment => d !== undefined && typeof d.body === "string")
      .slice(0, 3)
      .map((c) => ({
        id: c.id ?? "",
        body: c.body ?? "",
        author: c.author ?? "",
        score: c.score ?? 0,
        created_utc: c.created_utc ?? 0,
      }));
  } catch {
    return [];
  }
}
