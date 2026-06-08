// =============================================================================
// Eyes-MCP — GitHub adapter
//
// Two modes:
//   1. If `query` looks like an "owner/repo" slug, fetch that repo's metadata
//      and its README (base64-decoded into `readme_text`).
//   2. Otherwise search /search/repositories and return the top 10 hits.
//
// Auth: optional. If GITHUB_TOKEN is set, send `Authorization: Bearer …`
// which raises the rate limit from 60/hr (unauth) to 5000/hr (auth).
//
// Rate limit: we read `x-ratelimit-remaining` from the response and throw
// AdapterError("rate_limit") if the bucket is empty. The in-process token
// bucket in rate-limit.ts provides additional smoothing for unauth calls.
// =============================================================================

import { writeFile } from "node:fs/promises";
import {
  AdapterError,
  httpFetch,
  httpFetchJson,
  shardIdFromOutPath,
} from "./http.js";
import { createBucket } from "./rate-limit.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const OWNER_REPO_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/i;

// Be polite to GitHub when unauthenticated: 60 req/hr ≈ 1 token / 60s.
const bucket = createBucket({ capacity: 60, refillPerSec: 60 / 3600 });

interface GithubRepo {
  full_name?: string;
  description?: string | null;
  html_url?: string;
  stargazers_count?: number;
  language?: string | null;
  updated_at?: string;
  topics?: string[];
  forks_count?: number;
  open_issues_count?: number;
  default_branch?: string;
  private?: boolean;
}

interface GithubSearchResponse {
  total_count?: number;
  items?: GithubRepo[];
}

interface GithubReadmeResponse {
  content?: string;
  encoding?: string;
  name?: string;
  path?: string;
}

function authHeaders(): Record<string, string> {
  const tok = process.env["GITHUB_TOKEN"];
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

export const githubAdapter: ShardAdapter = {
  category: "github",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    await bucket.take();

    if (OWNER_REPO_RE.test(query.trim())) {
      await writeOwnerRepoShard(query.trim(), outPath, timeoutMs);
      return;
    }
    await writeSearchShard(query, outPath, timeoutMs);
  },
};

async function writeOwnerRepoShard(
  slug: string,
  outPath: string,
  timeoutMs: number,
): Promise<void> {
  const headers = authHeaders();
  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(slug)}`;
  const readmeUrl = `https://api.github.com/repos/${encodeURIComponent(slug)}/readme`;

  // Manual fetch so we can inspect x-ratelimit-remaining before parsing JSON.
  const repoRes = await httpFetch(repoUrl, {
    headers,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  checkRateLimit(repoRes, repoUrl);
  if (repoRes.status === 404) {
    throw new AdapterError(`github: repo ${slug} not found`, "not_found", {
      status: 404,
      url: repoUrl,
    });
  }
  const repo = (await repoRes.json()) as GithubRepo;

  // README is best-effort. Some repos have none (and 404 here is normal).
  let readmeText = "";
  try {
    const readmeRes = await httpFetch(readmeUrl, {
      headers,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    if (readmeRes.ok) {
      checkRateLimit(readmeRes, readmeUrl);
      const readme = (await readmeRes.json()) as GithubReadmeResponse;
      if (readme.content && readme.encoding === "base64") {
        readmeText = decodeBase64(readme.content);
      }
    }
  } catch {
    // Ignore — leave readmeText empty.
  }

  const artifact: RawShardArtifact = {
    shardId: shardIdFromOutPath(outPath),
    source: "github",
    query: slug,
    fetchedAt: new Date().toISOString(),
    payload: {
      mode: "repo" as const,
      full_name: repo.full_name ?? slug,
      description: repo.description ?? null,
      html_url: repo.html_url ?? "",
      stargazers_count: repo.stargazers_count ?? 0,
      language: repo.language ?? null,
      updated_at: repo.updated_at ?? "",
      topics: repo.topics ?? [],
      forks_count: repo.forks_count ?? 0,
      open_issues_count: repo.open_issues_count ?? 0,
      default_branch: repo.default_branch ?? "",
      private: repo.private ?? false,
      readme_text: readmeText,
      readme_bytes: readmeText.length,
    },
  };
  await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
}

async function writeSearchShard(
  query: string,
  outPath: string,
  timeoutMs: number,
): Promise<void> {
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}` +
    `&per_page=10&sort=stars&order=desc`;
  const headers = {
    ...authHeaders(),
    Accept: "application/vnd.github+json",
  };

  const res = await httpFetch(url, {
    headers,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  checkRateLimit(res, url);
  const data = (await res.json()) as GithubSearchResponse;

  const items = Array.isArray(data.items) ? data.items.slice(0, 10) : [];

  const artifact: RawShardArtifact = {
    shardId: shardIdFromOutPath(outPath),
    source: "github",
    query,
    fetchedAt: new Date().toISOString(),
    payload: {
      mode: "search" as const,
      total: data.total_count ?? items.length,
      items: items.map((r) => ({
        full_name: r.full_name ?? "",
        description: r.description ?? null,
        html_url: r.html_url ?? "",
        stargazers_count: r.stargazers_count ?? 0,
        language: r.language ?? null,
        updated_at: r.updated_at ?? "",
      })),
    },
  };
  await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
}

function checkRateLimit(res: Response, url: string): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && Number.parseInt(remaining, 10) === 0) {
    const reset = res.headers.get("x-ratelimit-reset") ?? "";
    throw new AdapterError(
      `github: rate limit exhausted (reset=${reset})`,
      "rate_limit",
      { status: 429, url },
    );
  }
}

/** Decode GitHub's base64 README payload, stripping whitespace and newlines. */
function decodeBase64(s: string): string {
  const cleaned = s.replace(/\s+/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf8");
  } catch {
    return "";
  }
}

// Silence unused-import warning if httpFetchJson isn't used directly.
void httpFetchJson;
