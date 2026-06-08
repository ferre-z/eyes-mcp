// =============================================================================
// Eyes-MCP — adapter types
//
// The canonical `ShardAdapter` interface lives in `src/dispatcher/types.ts`.
// This module re-exports it and adds internal helpers (the artifact envelope
// shape, the source-id enum used in raw files on disk) used by both the
// adapters and the parse layer.
//
// Why have a separate "source id" string? The dispatcher's `SourceCategory`
// is what the *main agent* sees in its shard list and ParsedShard. Internally,
// we have more granular ids (searxng vs. crawl4ai are both "web" to the agent
// but they are different fetchers), and we want them on disk for debugging
// without touching the public schema.
// =============================================================================

import type {
  Depth,
  ShardAdapter,
  ShardAdapterRegistry,
  SourceCategory,
} from "../dispatcher/types.js";

// ---------------------------------------------------------------------------
// SourceId — internal, lower-case, file-safe id used in raw artifacts.
// All ten adapters covered by subagent C map to one of these.
// ---------------------------------------------------------------------------

export const SOURCE_IDS = [
  "searxng",
  "crawl4ai",
  "github",
  "reddit",
  "youtube",
  "hackernews",
  "arxiv",
  "wikipedia",
  "osm",
  "generic",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** Map a SourceId to the public SourceCategory. The dispatcher's registry uses this. */
export const SOURCE_ID_TO_CATEGORY: Record<SourceId, SourceCategory> = {
  searxng: "web",
  crawl4ai: "web",
  github: "github",
  reddit: "reddit",
  youtube: "youtube",
  hackernews: "hackernews",
  arxiv: "arxiv",
  wikipedia: "wikipedia",
  // "osm" and "generic" aren't in the public SourceCategory enum, so they
  // map to "web" as a sensible default. Adapters that produce these raw
  // artifacts won't be wired into the dispatcher registry unless the
  // dispatcher is extended to include them.
  osm: "web",
  generic: "web",
};

// ---------------------------------------------------------------------------
// RawShardArtifact — the on-disk envelope every adapter writes to
// `{dataDir}/shards/{shardId}.{json|md}`. The parse layer reads this.
// ---------------------------------------------------------------------------

export interface RawShardArtifact {
  /** Same id as the dispatcher's Shard. */
  shardId: string;
  /** The internal source id (see SOURCE_IDS). */
  source: SourceId;
  /** Echoed back from the shard for traceability. */
  query: string;
  /** Wall-clock fetch time, ISO 8601. */
  fetchedAt: string;
  /** Adapter-specific payload. Discriminated by source. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Convenience: re-export the dispatcher's interface and registry type so
// adapter files have a single import.
// ---------------------------------------------------------------------------

export type { Depth, ShardAdapter, ShardAdapterRegistry, SourceCategory };

/**
 * Build a ShardAdapterRegistry from a list of (SourceId, ShardAdapter) pairs.
 * Maps each source id to its public category and inserts into a record.
 */
export function buildRegistry(
  entries: ReadonlyArray<{ sourceId: SourceId; adapter: ShardAdapter }>,
): ShardAdapterRegistry {
  const out: Record<string, ShardAdapter> = {};
  for (const { sourceId, adapter } of entries) {
    const cat = SOURCE_ID_TO_CATEGORY[sourceId];
    // Last write wins if two source ids map to the same category.
    if (!(cat in out)) out[cat] = adapter;
  }
  return out as ShardAdapterRegistry;
}
