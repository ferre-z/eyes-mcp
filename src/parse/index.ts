// =============================================================================
// Eyes-MCP — parse layer facade.
//
// This is the entry point the main agent uses. It runs the strip + chunk
// pipelines in sequence and returns the ParsedShard[] the rest of the
// system consumes. Sub-functions (tokenize, simhash, hamming, stripShards,
// chunkShards) are also re-exported for tests and direct callers.
// =============================================================================

import type { Logger } from "winston";
import type { Depth, ParsedShard } from "../dispatcher/types.js";
import { chunkShards, type LoggerLike } from "./chunk.js";
import { stripShards } from "./strip.js";
import { hamming, simhash, tokenize } from "./simhash.js";

export { stripShards, chunkShards };
export { tokenize, simhash, hamming };

export interface ParseRawOptions {
  dataDir: string;
  maxChunksPerShard: number;
  depth: Depth;
  logger?: LoggerLike;
}

type RawResult = { shardId: string; ok: boolean; rawPath?: string; error?: string };

/**
 * End-to-end parse: strip (layer 1) then chunk (layer 2). The main agent
 * calls this exactly once per dispatch round.
 */
export async function parseRawShards(
  shardResults: ReadonlyArray<RawResult>,
  opts: ParseRawOptions,
): Promise<ParsedShard[]> {
  await stripShards(shardResults, {
    dataDir: opts.dataDir,
    depth: opts.depth,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return chunkShards(shardResults, {
    dataDir: opts.dataDir,
    maxChunksPerShard: opts.maxChunksPerShard,
    depth: opts.depth,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

// Re-export the logger type for callers that want to type their own loggers.
export type { LoggerLike };
// Keep `Logger` import used at the type level for downstream consumers that
// want to construct a `LoggerLike` from a full winston Logger.
export type { Logger };
