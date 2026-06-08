// =============================================================================
// Eyes-MCP — small text utilities for the parse layer.
//
// Pure functions, no I/O. Kept dependency-free so the parse layer can run
// in environments without network access (the L1 stripper, in particular,
// runs before the LLM has any work to do).
// =============================================================================

/**
 * Strip HTML tags, unescape the five most common entities, and collapse
 * whitespace. Intentionally tiny — we are not trying to render HTML, we
 * are just trying to get a roughly-readable text blob.
 */
export function stripHtml(s: string): string {
  if (!s) return "";
  const noTags = s.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  const unescaped = noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return collapseWhitespace(unescaped);
}

/** Collapse runs of whitespace into a single space, then trim. */
export function collapseWhitespace(s: string): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/** Split a block into paragraphs on one-or-more blank lines. */
export function splitParagraphs(s: string): string[] {
  if (!s) return [];
  return s
    .split(/\n\n+/)
    .map((p) => p.replace(/\s+$/g, ""))
    .filter((p) => p.length > 0);
}

/** Split a block into sentences on sentence-final punctuation. */
export function splitSentences(s: string): string[] {
  if (!s) return [];
  return s
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.replace(/\s+$/g, ""))
    .filter((p) => p.length > 0);
}

/** Cheap "how many tokens is this" estimate. ~4 chars per token. */
export function approximateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Does this string look like an http(s) URL (after a trim)? */
export function looksLikeUrl(s: string): boolean {
  if (!s) return false;
  return s.trim().match(/^https?:\/\//) !== null;
}

/** Return the first http(s) URL in `text`, or undefined if none. */
export function extractFirstUrl(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https?:\/\/[^\s)\]>"']+/);
  return m ? m[0] : undefined;
}
