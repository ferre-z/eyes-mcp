// =============================================================================
// Eyes-MCP — shard dispatcher
//
// Fans a list of Shards out to per-source adapters in parallel, bounded by
// p-limit. Each successful result is written to /data/shards/{shardId}.json
// (the artifact pattern — main agent never sees the raw bytes, only the path).
//
// Subagent C owns the actual adapter implementations. This module only
// defines the ShardAdapter interface (in ./types.ts) and a registry that
// `index.ts` populates.
// =============================================================================

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pLimit from "p-limit";
import { logger as rootLogger } from "../util/logger.js";
import type {
  Depth,
  RawShardResult,
  Shard,
  ShardAdapter,
  ShardAdapterRegistry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DispatcherConfig {
  /** Where successful artifacts are written. Default $EYES_DATA_DIR or /data. */
  dataDir?: string;
  /** Max shards in flight at once. Default 4. */
  concurrency?: number;
  /** Per-shard adapter timeout, ms. Default 30000. */
  timeoutMs?: number;
  /** Inject adapters. If unset, the dispatcher will skip missing categories. */
  adapters?: ShardAdapterRegistry;
  /** Optional logger (per-request). Falls back to the root logger. */
  logger?: Pick<typeof rootLogger, "info" | "warn" | "error" | "debug">;
}

// ---------------------------------------------------------------------------
// Per-shard runner — wraps an adapter call with a timeout, error capture,
// and artifact write.
// ---------------------------------------------------------------------------

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runShard(
  shard: Shard,
  depth: Depth,
  outPath: string,
  timeoutMs: number,
  registry: ShardAdapterRegistry,
  log: DispatcherConfig["logger"],
): Promise<RawShardResult> {
  const t0 = Date.now();
  const adapter: ShardAdapter | undefined = registry[shard.source.category];

  if (!adapter) {
    log?.warn("dispatcher: no adapter for category", {
      shardId: shard.id,
      category: shard.source.category,
    });
    return {
      shardId: shard.id,
      ok: false,
      error: `no adapter registered for category "${shard.source.category}"`,
    };
  }

  try {
    await withTimeout(
      adapter.search(shard.query, shard.source.hint, depth, outPath, timeoutMs),
      timeoutMs,
      `shard ${shard.id}`,
    );
    return { shardId: shard.id, ok: true, rawPath: outPath, adapterMs: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.error("dispatcher: shard failed", { shardId: shard.id, err: message });
    return { shardId: shard.id, ok: false, error: message, adapterMs: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch a batch of shards in parallel, with bounded concurrency.
 * Each successful result is persisted to `{dataDir}/shards/{shardId}.json`.
 * Failed shards return `{ok:false, error}`; they do not throw.
 */
export async function dispatchShards(
  shards: ReadonlyArray<Shard>,
  depth: Depth,
  config: DispatcherConfig = {},
): Promise<RawShardResult[]> {
  if (shards.length === 0) return [];

  const dataDir = (config.dataDir ?? process.env["EYES_DATA_DIR"] ?? "/data").replace(/\/$/, "");
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const registry: ShardAdapterRegistry = config.adapters ?? {};
  const log = config.logger ?? rootLogger;

  const shardsDir = path.join(dataDir, "shards");
  await mkdir(shardsDir, { recursive: true });

  const limit = pLimit(Math.max(1, concurrency));

  log.info("dispatcher: starting", {
    count: shards.length,
    concurrency,
    timeoutMs,
    dataDir,
  });

  const tasks = shards.map((shard) =>
    limit(async () => {
      const outPath = path.join(shardsDir, `${shard.id}.json`);
      const result = await runShard(shard, depth, outPath, timeoutMs, registry, log);
      // Best-effort: persist a small status envelope so even failed shards
      // leave a trail. The parse layer will skip these.
      if (!result.ok) {
        try {
          await writeFile(
            outPath,
            JSON.stringify(
              {
                shardId: result.shardId,
                ok: false,
                error: result.error ?? "unknown",
                writtenAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch (writeErr) {
          log?.warn("dispatcher: failed to write error envelope", {
            shardId: shard.id,
            err: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        }
      }
      return result;
    }),
  );

  const results = await Promise.all(tasks);

  const okCount = results.filter((r) => r.ok).length;
  log.info("dispatcher: done", { ok: okCount, failed: results.length - okCount });

  return results;
}

// ---------------------------------------------------------------------------
// Helpers (re-exported for tests + main agent).
// ---------------------------------------------------------------------------

/** Generate a shard id slug. */
export function slugifyShardId(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || randomUUID().slice(0, 8);
}
