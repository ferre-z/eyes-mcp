// =============================================================================
// Eyes-MCP — heuristic decomposer
//
// Used when there's no LLM available (no GEMINI_API_KEY). Deterministic,
// template-based, predictable. Returns a Shard[] that is at least as good
// as "send one shard per requested source".
// =============================================================================

import { slugifyShardId } from "../dispatcher/index.js";
import type { Shard, Source } from "../dispatcher/types.js";

/**
 * Standard set of source categories used when the caller says "general" or
 * passes no specific scope. Order = priority (first one wins when we hit
 * maxShards).
 */
const STANDARD_CATEGORIES: Array<Source["category"]> = [
  "web",
  "github",
  "reddit",
  "hackernews",
  "youtube",
  "arxiv",
  "wikipedia",
];

/** Make one shard for a given source + query. */
function makeShard(query: string, source: Source, why: string): Shard {
  return {
    id: `${source.category}-${slugifyShardId(query)}`,
    query,
    source,
    // Marker prefix lets the main agent detect when decomposition fell back
    // to the heuristic path (so it can report an honest `mode`).
    why: `[heuristic] ${why}`,
  };
}

/**
 * Heuristic decompose. Pure function — no I/O, no LLM, easy to test.
 *
 * Rules (per the task spec):
 *  1. If scope is exactly 1 source, return 1 shard.
 *  2. If scope is "general" (or empty), emit one shard per standard category,
 *     capped at maxShards.
 *  3. If scope is multiple specific categories, one shard per scope + up to
 *     2 reformulations for the web category (if web is in scope, or added
 *     implicitly as fallback).
 *
 * `web` is always preferred when there's a single slot: it's the broadest
 * source (SearXNG meta-search) and is almost always the right first pick
 * when the caller hasn't said otherwise. So when normalized.length > 1 and
 * cap >= 1, we put a web shard first, then fill the remaining cap with
 * other sources.
 */
export function decomposeHeuristic(
  prompt: string,
  scope: ReadonlyArray<Source>,
  maxShards: number,
): Shard[] {
  const cap = Math.max(1, maxShards);
  const out: Shard[] = [];

  // Normalize: if user passed [{category:"general"}] or empty, fan out.
  const normalized: Source[] =
    scope.length === 0 ||
    scope.every((s) => s.category === "general")
      ? STANDARD_CATEGORIES.map((c) => ({ category: c }))
      : [...scope];

  // Rule 1: exactly 1 explicit source.
  if (normalized.length === 1) {
    const only = normalized[0]!;
    out.push(makeShard(prompt, only, `Targeted search on the single requested source (${only.category}).`));
    return out;
  }

  // Rule 2 & 3: multiple sources.
  const hasWeb = normalized.some((s) => s.category === "web");
  const others = normalized.filter((s) => s.category !== "web");

  // Web first (with a single reformulation) when there's room. This is
  // the bug-fix: with cap=1 + general scope, we used to skip web entirely
  // and pick `github` (the first non-web in STANDARD_CATEGORIES). Now
  // web always wins the first slot when it's in scope (or implicit).
  if (out.length < cap) {
    const reformulations = reformulateQuery(prompt, 1);
    for (const q of reformulations) {
      if (out.length >= cap) break;
      out.push(
        makeShard(
          q,
          { category: "web" },
          `Web search (${q === prompt ? "exact" : "paraphrased"}) — broadest coverage, first pick.`,
        ),
      );
    }
  }

  // Then one shard per other source in scope.
  for (const src of others) {
    if (out.length >= cap) break;
    out.push(
      makeShard(
        prompt,
        src,
        `Source-specific angle on "${prompt}" from ${src.category}${src.hint ? ` (${src.hint})` : ""}.`,
      ),
    );
  }

  // If the caller asked for more shards than sources+web and `hasWeb` was
  // implicit (not in their scope list), they get a second web reformulation
  // to fill the gap.
  if (out.length < cap && hasWeb) {
    const reformulations = reformulateQuery(prompt, 2).slice(1); // skip the one we already used
    for (const q of reformulations) {
      if (out.length >= cap) break;
      out.push(
        makeShard(
          q,
          { category: "web" },
          `Web reformulation (${q === prompt ? "exact" : "paraphrased"}) for broad coverage.`,
        ),
      );
    }
  }

  // If we still have room and the caller explicitly listed more sources,
  // keep going through them (covers "scope = many, no web" cases).
  if (out.length < cap) {
    for (const src of normalized) {
      if (out.length >= cap) break;
      if (out.some((s) => s.source.category === src.category)) continue;
      out.push(
        makeShard(
          prompt,
          src,
          `Additional angle on "${prompt}" from ${src.category}.`,
        ),
      );
    }
  }

  return out.slice(0, cap);
}

/**
 * Produce up to `n` distinct reformulations of a query. Heuristic only —
 * the real LLM does this better. We just prepend/append a couple of qualifiers.
 */
function reformulateQuery(prompt: string, n: number): string[] {
  const out = [prompt];
  const p = prompt.trim();
  const last = p.endsWith("?") ? p.slice(0, -1) : p;
  if (n >= 2) out.push(`${last} explained`);
  if (n >= 3) out.push(`${last} examples`);
  return out.slice(0, Math.max(1, n));
}
