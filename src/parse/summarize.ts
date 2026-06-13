// =============================================================================
// Eyes-MCP — adapter-specific artifact summarizers
//
// Each adapter writes a JSON envelope with a `source` id (one of the
// SourceId enum from src/adapters/types.ts) and a `payload` shaped to that
// adapter. The strip layer used to call a generic flattenObject() that
// turned everything into "key: value" lines and joined array members
// with "|", which produced a single line of text per shard — defeating
// the chunk layer's per-paragraph dedup and producing wall-of-JSON
// synthesized answers.
//
// This module replaces that with per-adapter summarizers. Each
// summarizer knows the shape of its adapter's payload and emits a
// markdown-ish string with real paragraph structure that the chunk
// layer can actually split on `\n\n`.
//
// All summarizers are pure: input is a string (the raw artifact body),
// output is a string. They do not touch the filesystem.
// =============================================================================

import { collapseWhitespace, stripHtml } from "./text.js";

/** SourceId values that have a registered summarizer. */
import type { SourceId } from "../adapters/types.js";

/** A summarizer turns a raw artifact body into a text-friendly string. */
export type ArtifactSummarizer = (rawArtifact: string) => string;

/** Soft cap on a single field's length, to keep huge READMEs from dominating. */
const MAX_FIELD = 8000;

/** Helper: extract the parsed JSON envelope, or null if it isn't valid JSON. */
function safeParse(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Helper: get a string field, with a default. */
function strField(obj: Record<string, unknown>, key: string, def = ""): string {
  const v = obj[key];
  return typeof v === "string" ? v : def;
}

/** Helper: get a number field. */
function numField(obj: Record<string, unknown>, key: string, def = 0): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

/** Helper: get an array field. */
function arrField<T = unknown>(obj: Record<string, unknown>, key: string): T[] {
  const v = obj[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

// ---------------------------------------------------------------------------
// Per-source summarizers
// ---------------------------------------------------------------------------

const summarizeSearxng: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const results = arrField<Record<string, unknown>>(payload, "results");
  const blocks: string[] = [];
  for (const r of results) {
    const title = strField(r, "title");
    const url = strField(r, "url");
    const snippet = stripHtml(strField(r, "snippet"));
    if (!title && !snippet) continue;
    const head = title && url ? `- [${title}](${url})` : title ? `- ${title}` : `- ${url}`;
    blocks.push(snippet ? `${head}\n  ${snippet}` : head);
  }
  return blocks.join("\n\n") || "(no results)";
};

const summarizeGithub: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const mode = strField(payload, "mode");
  if (mode === "repo") {
    const fullName = strField(payload, "full_name") || "unknown/repo";
    const description = strField(payload, "description");
    const htmlUrl = strField(payload, "html_url");
    const stars = numField(payload, "stargazers_count");
    const language = strField(payload, "language");
    const updated = strField(payload, "updated_at");
    const readme = strField(payload, "readme_text").slice(0, MAX_FIELD);
    const topics = arrField<string>(payload, "topics");
    const head = [
      `# ${fullName}`,
      description,
      htmlUrl ? `\nURL: ${htmlUrl}` : "",
      `\nStats: ${stars} stars · ${language || "unknown language"} · last updated ${updated || "unknown"}`,
      topics.length > 0 ? `\nTopics: ${topics.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return readme ? `${head}\n\n## README\n${stripHtml(readme)}` : head;
  }
  // search mode
  const items = arrField<Record<string, unknown>>(payload, "items");
  const total = numField(payload, "total");
  const blocks: string[] = [`Found ${total} repositories. Top hits:`];
  for (const r of items) {
    const fullName = strField(r, "full_name");
    const description = strField(r, "description");
    const stars = numField(r, "stargazers_count");
    const language = strField(r, "language");
    const url = strField(r, "html_url");
    const head = fullName && url ? `- [${fullName}](${url})` : `- ${fullName}`;
    const meta = `${stars} stars · ${language || "—"}`;
    blocks.push(description ? `${head} (${meta})\n  ${description}` : `${head} (${meta})`);
  }
  return blocks.join("\n\n");
};

const summarizeReddit: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const posts = arrField<Record<string, unknown>>(payload, "posts");
  const blocks: string[] = [];
  for (const p of posts) {
    const title = strField(p, "title");
    const url = strField(p, "url");
    const sub = strField(p, "subreddit");
    const author = strField(p, "author");
    const score = numField(p, "score");
    const numComments = numField(p, "num_comments");
    const selftext = strField(p, "selftext");
    const comments = arrField<Record<string, unknown>>(p, "top_comments");
    const head = `- ${title} (r/${sub}, ${score}↑, ${numComments} comments, by u/${author})`;
    const tail = comments.length > 0
      ? `\n  Top comments:\n${comments
          .map((c) => `    > ${collapseWhitespace(strField(c, "body"))} (u/${strField(c, "author")}, ${numField(c, "score")}↑)`)
          .join("\n")}`
      : "";
    const body = selftext ? `\n  ${selftext}` : url && url !== strField(p, "permalink") ? `\n  Link: ${url}` : "";
    blocks.push(`${head}${body}${tail}`);
  }
  return blocks.join("\n\n") || "(no posts)";
};

const summarizeHackernews: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const items = arrField<Record<string, unknown>>(payload, "items");
  const total = numField(payload, "total");
  const blocks: string[] = [`Found ${total} stories. Top hits:`];
  for (const it of items) {
    const title = strField(it, "title");
    const url = strField(it, "url");
    const points = numField(it, "points");
    const numComments = numField(it, "numComments");
    const author = strField(it, "author");
    blocks.push(`- [${title}](${url}) — ${points}↑, ${numComments} comments, by ${author}`);
  }
  return blocks.join("\n\n");
};

const summarizeArxiv: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const items = arrField<Record<string, unknown>>(payload, "items");
  const blocks: string[] = [];
  for (const it of items) {
    const title = collapseWhitespace(strField(it, "title"));
    const summary = collapseWhitespace(strField(it, "summary"));
    const link = strField(it, "link");
    const published = strField(it, "published");
    const authors = arrField<string>(it, "authors");
    const authorList = authors.length === 0 ? "Unknown authors" : authors.length <= 3 ? authors.join(", ") : `${authors.slice(0, 2).join(", ")} + ${authors.length - 2} more`;
    blocks.push(`## ${title}\nby ${authorList} — ${published}\n\n${summary}\n\n[arXiv link](${link})`);
  }
  return blocks.join("\n\n") || "(no papers)";
};

const summarizeWikipedia: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const hits = arrField<Record<string, unknown>>(payload, "hits");
  const summaries = arrField<Record<string, unknown>>(payload, "summaries");
  const blocks: string[] = [];
  // Map summaries by title.
  const summaryByTitle = new Map<string, Record<string, unknown>>();
  for (const s of summaries) {
    const t = strField(s, "title");
    if (t) summaryByTitle.set(t, s);
  }
  for (const h of hits) {
    const title = strField(h, "title");
    const snippet = strField(h, "snippet");
    const s = summaryByTitle.get(title);
    if (s) {
      const extract = stripHtml(strField(s, "extract")).slice(0, MAX_FIELD);
      const desc = strField(s, "description");
      const page = (s["content_urls"] as Record<string, Record<string, string>> | undefined)?.desktop?.page;
      const head = `## ${title}`;
      const link = page ? `\n[Read more](${page})` : "";
      blocks.push(desc ? `${head}\n${desc}\n\n${extract}${link}` : `${head}\n\n${extract}${link}`);
    } else if (snippet) {
      blocks.push(`## ${title}\n${snippet}`);
    }
  }
  return blocks.join("\n\n") || "(no hits)";
};

const summarizeYoutube: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const metadata = (payload["metadata"] as Record<string, unknown> | undefined) ?? null;
  const transcript = (payload["transcript"] as Record<string, unknown> | undefined) ?? null;
  if (!metadata || !strField(metadata, "title")) {
    return "(no video metadata — only a YouTube URL produces a usable artifact)";
  }
  const title = strField(metadata, "title");
  const author = strField(metadata, "author_name");
  const url = strField(payload, "url");
  const head = `# ${title}\nby ${author}${url ? ` — [video](${url})` : ""}`;
  if (!transcript) return head + "\n\n(no transcript available)";
  const available = Boolean(transcript["available"]);
  const text = collapseWhitespace(strField(transcript, "text")).slice(0, MAX_FIELD);
  if (!available || text.length === 0) return head + "\n\n(no transcript available)";
  return `${head}\n\n## Transcript\n${text}`;
};

const summarizeCrawl4ai: ArtifactSummarizer = (raw) => {
  // Crawl4AI's payload IS the markdown. We just lightly normalize.
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const md = strField(payload, "markdown");
  return md || "(empty markdown)";
};

const summarizeGeneric: ArtifactSummarizer = summarizeCrawl4ai;

const summarizeOsm: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = (env["payload"] as Record<string, unknown> | undefined) ?? {};
  const results = arrField<Record<string, unknown>>(payload, "results");
  const blocks: string[] = [];
  for (const r of results) {
    const name = strField(r, "display_name");
    const type = strField(r, "type");
    const cls = strField(r, "class");
    const lat = strField(r, "lat");
    const lon = strField(r, "lon");
    blocks.push(`- **${name}** (${cls}/${type}) — lat ${lat}, lon ${lon}`);
  }
  return blocks.join("\n\n") || "(no places)";
};

/** Generic fallback: stringify a payload of unknown shape. */
const summarizeGenericFallback: ArtifactSummarizer = (raw) => {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const payload = env["payload"];
  if (!payload) return stripHtml(raw);
  if (typeof payload === "string") return stripHtml(payload);
  return stripHtml(JSON.stringify(payload, null, 2).slice(0, MAX_FIELD));
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SUMMARIZERS: Record<SourceId, ArtifactSummarizer> = {
  searxng: summarizeSearxng,
  github: summarizeGithub,
  reddit: summarizeReddit,
  hackernews: summarizeHackernews,
  arxiv: summarizeArxiv,
  wikipedia: summarizeWikipedia,
  youtube: summarizeYoutube,
  crawl4ai: summarizeCrawl4ai,
  generic: summarizeGeneric,
  osm: summarizeOsm,
};

/**
 * Look up the summarizer for a given raw artifact. Falls back to the
 * generic text dumper if the source id is unknown or missing.
 */
export function getSummarizer(sourceId: string): ArtifactSummarizer {
  if (sourceId in SUMMARIZERS) {
    return SUMMARIZERS[sourceId as SourceId];
  }
  return summarizeGenericFallback;
}

/**
 * Convenience: pull the `source` field out of the artifact and run its
 * summarizer. Returns the generic fallback output if the artifact isn't
 * valid JSON or has no `source` field.
 */
export function summarizeArtifact(raw: string): string {
  const env = safeParse(raw);
  if (!env) return stripHtml(raw);
  const source = strField(env, "source");
  if (!source) return summarizeGenericFallback(raw);
  return getSummarizer(source)(raw);
}
