// =============================================================================
// Eyes-MCP — shared types for the dispatcher + main agent.
//
// Conventions:
//   * Zod schemas are the source of truth for runtime validation.
//   * TypeScript types are derived from the Zod schemas via `z.infer`.
//   * All shapes that cross a module boundary live here.
// =============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// Depth — drives parse aggressiveness and sub-agent result counts.
// ---------------------------------------------------------------------------

export const DepthSchema = z.enum(["quick", "standard", "deep"]);
export type Depth = z.infer<typeof DepthSchema>;

// ---------------------------------------------------------------------------
// Source categories. Each maps to one or more adapters (owned by subagent C).
// "general" is the meta-category that means "fan out to the standard set".
// ---------------------------------------------------------------------------

export const SourceCategorySchema = z.enum([
  "general",
  "web",
  "github",
  "reddit",
  "youtube",
  "hackernews",
  "arxiv",
  "wikipedia",
]);
export type SourceCategory = z.infer<typeof SourceCategorySchema>;

export const SourceSchema = z.object({
  /** Canonical category name. */
  category: SourceCategorySchema,
  /** Free-form hint (e.g. a specific subreddit, a github org). Optional. */
  hint: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// Shard — the unit of work fanned out to a sub-agent. Created by the main
// agent's decomposer; consumed by the dispatcher; produces raw artifacts on
// disk which the parse layer (subagent C) then turns into ParsedShards.
// ---------------------------------------------------------------------------

export const ShardSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  source: SourceSchema,
  /** One-sentence rationale from the decomposer; surfaced in logs + UI. */
  why: z.string().min(1),
});
export type Shard = z.infer<typeof ShardSchema>;

// ---------------------------------------------------------------------------
// RawShardResult — what the dispatcher writes after calling an adapter.
// `rawPath` is the on-disk JSON file; `error` is non-null when ok=false.
// ---------------------------------------------------------------------------

export const RawShardResultSchema = z.object({
  shardId: z.string().min(1),
  ok: z.boolean(),
  rawPath: z.string().optional(),
  error: z.string().optional(),
  /** Wall-clock ms spent in the adapter (excludes queue/dispatch overhead). */
  adapterMs: z.number().int().nonnegative().optional(),
  /** True when the dispatcher reused an existing on-disk artifact. */
  cacheHit: z.boolean().optional(),
});
export type RawShardResult = z.infer<typeof RawShardResultSchema>;

// ---------------------------------------------------------------------------
// ParsedShard — what the parse layers produce, what the main agent reviews.
// Grouped by shard_id (themes == shards, no re-clustering, per architecture
// doc 03-architecture-main-and-swarm.md).
// ---------------------------------------------------------------------------

export const ChunkSchema = z.object({
  text: z.string(),
  url: z.string().optional(),
  charOffset: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const ParsedShardSchema = z.object({
  shardId: z.string().min(1),
  source: SourceCategorySchema,
  /** Cheap 1-2 sentence summary the main agent sees during review. */
  summary: z.string(),
  chunks: z.array(ChunkSchema),
});
export type ParsedShard = z.infer<typeof ParsedShardSchema>;

// ---------------------------------------------------------------------------
// Caller-facing input schema (the MCP tool contract).
// ---------------------------------------------------------------------------

export const OutputFormatSchema = z.enum(["markdown", "json", "summary"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const ResearchInputSchema = z.object({
  /** The research question. Required. */
  prompt: z.string().min(1),
  /** Strip aggressiveness. Default: "standard". */
  depth: DepthSchema.default("standard"),
  /** Hard cap on shards per iteration. Default 5, capped at 20. */
  maxShards: z.number().int().min(1).max(20).default(5),
  /** Hard cap on refine-loop iterations. Default 2, capped at 5. */
  maxIterations: z.number().int().min(1).max(5).default(2),
  /** Which source categories to consult. Default ["general"]. */
  scope: z.array(SourceCategorySchema).min(1).default(["general"]),
  /** How the final answer should be formatted. Default "markdown". */
  outputFormat: OutputFormatSchema.default("markdown"),
});
export type ResearchInput = z.infer<typeof ResearchInputSchema>;

// ---------------------------------------------------------------------------
// Output schema — what the MCP tool returns to the caller.
// ---------------------------------------------------------------------------

export const ResearchOutputSchema = z.object({
  /** The synthesized final answer. */
  answer: z.string(),
  /** All shards that ran across all iterations, in dispatch order. */
  shards: z.array(
    z.object({
      id: z.string(),
      source: SourceCategorySchema,
      query: z.string(),
      why: z.string(),
      ok: z.boolean(),
      chunkCount: z.number().int().nonnegative(),
    }),
  ),
  iterations: z.number().int().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** "llm" or "heuristic" — which mode the main agent ran in. */
  mode: z.enum(["llm", "heuristic"]),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// ---------------------------------------------------------------------------
// ReviewDecision — what the main agent emits after seeing the parsed shards.
// ---------------------------------------------------------------------------

export const ReviewDecisionSchema = z.union([
  z.object({
    type: z.literal("return"),
    answer: z.string().min(1),
  }),
  z.object({
    type: z.literal("refine"),
    newShards: z.array(ShardSchema).min(1),
    reason: z.string().min(1),
  }),
]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

// ---------------------------------------------------------------------------
// ShardAdapter — the interface subagent C's adapters must implement.
// Defined here (not in src/adapters/) because the dispatcher needs to type
// the registry; subagent C fills in concrete implementations.
// ---------------------------------------------------------------------------

export interface ShardAdapter {
  /** The category this adapter handles. */
  readonly category: SourceCategory;
  /**
   * Run the shard. Must be idempotent within `timeoutMs`. Implementations
   * write their raw output to `outPath` (the dispatcher will pass this in).
   * Throwing is OK — the dispatcher catches and marks `ok=false`.
   */
  search(
    query: string,
    hint: string | undefined,
    depth: Depth,
    outPath: string,
    timeoutMs: number,
  ): Promise<void>;
}

export type ShardAdapterRegistry = Partial<Record<SourceCategory, ShardAdapter>>;
