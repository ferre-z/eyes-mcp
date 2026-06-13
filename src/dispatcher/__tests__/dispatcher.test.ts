// =============================================================================
// Eyes-MCP — dispatcher tests
//
// We don't hit the network. Each test injects a mock adapter that writes
// a tiny artifact file, and we verify dispatchShards:
//   * routes by SourceCategory
//   * records ok / error properly
//   * runs adapters in parallel (concurrency cap)
//   * handles adapter throws
//   * writes an error envelope for failed shards
//   * generates a deterministic slug for shard IDs
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatchShards, slugifyShardId } from "../index.js";
import type { Shard, ShardAdapter } from "../types.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkTmpDataDir();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function mkTmpDataDir(): Promise<string> {
  const base = path.join(tmpdir(), `eyes-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(base, { recursive: true });
  return base;
}

function shard(category: Shard["source"]["category"], id: string, query: string): Shard {
  return { id, query, source: { category }, why: "test" };
}

function okAdapter(label: string): ShardAdapter {
  return {
    category: "web",
    async search(query, _hint, _depth, outPath, _timeoutMs) {
      // The artifact envelope is what real adapters write. The soft
      // validator runs on this and expects the new shape.
      const shardId = path.basename(outPath, ".json");
      await writeFileSafe(
        outPath,
        JSON.stringify(
          {
            shardId,
            source: "searxng",
            query,
            fetchedAt: new Date().toISOString(),
            payload: { ok: true, label },
          },
          null,
          2,
        ),
      );
    },
  };
}

function failingAdapter(message: string): ShardAdapter {
  return {
    category: "web",
    async search() {
      throw new Error(message);
    },
  };
}

async function writeFileSafe(p: string, contents: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, contents, "utf8");
}

describe("dispatcher: dispatchShards", () => {
  it("returns [] for an empty input list", async () => {
    const out = await dispatchShards([], "standard", { dataDir });
    expect(out).toEqual([]);
  });

  it("routes a single web shard through the registered web adapter", async () => {
    const adapters = { web: okAdapter("web") };
    const out = await dispatchShards([shard("web", "abc", "rust")], "standard", { dataDir, adapters });
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(true);
    expect(out[0]!.shardId).toBe("abc");
    expect(out[0]!.rawPath).toBe(path.join(dataDir, "shards", "abc.json"));
    const onDisk = JSON.parse(await readFile(out[0]!.rawPath!, "utf8"));
    // The on-disk shape is the new envelope: { shardId, source, query, fetchedAt, payload }.
    expect(onDisk).toMatchObject({
      shardId: "abc",
      source: "searxng",
      query: "rust",
      payload: { ok: true, label: "web" },
    });
  });

  it("marks the shard failed when no adapter is registered for the category", async () => {
    const out = await dispatchShards([shard("github", "g", "x")], "standard", { dataDir, adapters: {} });
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.error).toMatch(/no adapter registered/);
  });

  it("captures an adapter throw as ok=false with the error message", async () => {
    const adapters = { web: failingAdapter("upstream down") };
    const out = await dispatchShards([shard("web", "f", "x")], "standard", { dataDir, adapters });
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.error).toBe("upstream down");
  });

  it("writes a JSON error envelope when the adapter throws (for the parse layer)", async () => {
    const adapters = { web: failingAdapter("nope") };
    const out = await dispatchShards([shard("web", "e1", "x")], "standard", { dataDir, adapters });
    const envPath = path.join(dataDir, "shards", "e1.json");
    const env = JSON.parse(await readFile(envPath, "utf8"));
    expect(env.shardId).toBe("e1");
    expect(env.ok).toBe(false);
    expect(env.error).toBe("nope");
    expect(env.writtenAt).toBeTruthy();
  });

  it("runs multiple shards in parallel", async () => {
    const startedAt: number[] = [];
    const adapters: Record<string, ShardAdapter> = {
      web: {
        category: "web",
        async search(_q, _h, _d, outPath, _t) {
          startedAt.push(Date.now());
          await new Promise((r) => setTimeout(r, 200));
          const shardId = path.basename(outPath, ".json");
          await writeFileSafe(outPath, JSON.stringify({ shardId, source: "searxng", fetchedAt: "2024-01-01", payload: { ok: true } }));
        },
      },
    };
    const shards = [shard("web", "a", "x"), shard("web", "b", "y"), shard("web", "c", "z")];
    const t0 = Date.now();
    await dispatchShards(shards, "standard", { dataDir, adapters, concurrency: 3 });
    const total = Date.now() - t0;
    // 3 shards × 200ms each, but parallel: should be ~200ms (or a bit more),
    // not 600ms.
    expect(total).toBeLessThan(500);
    // Each adapter should have started at nearly the same instant.
    const spread = Math.max(...startedAt) - Math.min(...startedAt);
    expect(spread).toBeLessThan(100);
  });

  it("respects concurrency limit (does not exceed max in-flight)", async () => {
    let inFlight = 0;
    let peak = 0;
    const adapters: Record<string, ShardAdapter> = {
      web: {
        category: "web",
        async search(_q, _h, _d, outPath, _t) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 50));
          const shardId = path.basename(outPath, ".json");
          await writeFileSafe(outPath, JSON.stringify({ shardId, source: "searxng", fetchedAt: "2024-01-01", payload: { ok: true } }));
          inFlight--;
        },
      },
    };
    const shards = Array.from({ length: 6 }, (_, i) => shard("web", `s${i}`, "x"));
    await dispatchShards(shards, "standard", { dataDir, adapters, concurrency: 2 });
    expect(peak).toBe(2);
  });

  it("preserves dispatch order in the result array", async () => {
    const adapters = { web: okAdapter("web"), github: okAdapter("github") };
    const shards = [
      shard("web", "w1", "x"),
      shard("github", "g1", "y"),
      shard("web", "w2", "z"),
    ];
    const out = await dispatchShards(shards, "standard", { dataDir, adapters });
    expect(out.map((r) => r.shardId)).toEqual(["w1", "g1", "w2"]);
  });

  it("creates the shards dir if missing", async () => {
    const adapters = { web: okAdapter("web") };
    await dispatchShards([shard("web", "x", "q")], "standard", { dataDir, adapters });
    const exists = await readFile(path.join(dataDir, "shards", "x.json"), "utf8");
    expect(exists).toBeTruthy();
  });

  it("returns adapterMs in the result", async () => {
    const adapters = { web: okAdapter("web") };
    const out = await dispatchShards([shard("web", "a", "q")], "standard", { dataDir, adapters });
    expect(typeof out[0]!.adapterMs).toBe("number");
    expect(out[0]!.adapterMs).toBeGreaterThanOrEqual(0);
  });

  it("soft validation: a malformed artifact keeps ok=true and logs a warning", async () => {
    // The adapter writes a non-JSON body. The dispatcher must NOT fail the
    // shard (soft path) but the warning should be logged.
    const malformedAdapter: ShardAdapter = {
      category: "web",
      async search(_q, _h, _d, outPath, _t) {
        await writeFileSafe(outPath, "not json at all{");
      },
    };
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} };
    const out = await dispatchShards([shard("web", "bad1", "q")], "standard", {
      dataDir,
      adapters: { web: malformedAdapter },
      logger: logger as never,
    });
    expect(out[0]!.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    const call = warn.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("artifact shape is unexpected"),
    );
    expect(call).toBeTruthy();
  });

  it("soft validation: a well-formed artifact produces no validation warning", async () => {
    const warn = vi.fn();
    const logger = { info: () => {}, warn, error: () => {}, debug: () => {} };
    await dispatchShards([shard("web", "ok1", "q")], "standard", {
      dataDir,
      adapters: { web: okAdapter("web") },
      logger: logger as never,
    });
    const validationWarnings = warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("artifact shape is unexpected"),
    );
    expect(validationWarnings).toHaveLength(0);
  });

  it("caches shard artifacts and skips the adapter when within TTL", async () => {
    const adapters = { web: okAdapter("web") };
    const shardId = "cached-web";
    const shardsDir = path.join(dataDir, "shards");
    await mkdir(shardsDir, { recursive: true });
    await writeFileSafe(
      path.join(shardsDir, `${shardId}.json`),
      JSON.stringify({
        shardId,
        source: "searxng",
        query: "rust",
        fetchedAt: new Date().toISOString(),
        payload: { ok: true, label: "cached" },
      }),
    );

    const calls: string[] = [];
    const countingAdapter: ShardAdapter = {
      category: "web",
      async search(_q, _h, _d, outPath, _t) {
        calls.push(outPath);
        const id = path.basename(outPath, ".json");
        await writeFileSafe(
          outPath,
          JSON.stringify({
            shardId: id,
            source: "searxng",
            fetchedAt: new Date().toISOString(),
            payload: { ok: true, label: "fresh" },
          }),
        );
      },
    };

    const out = await dispatchShards([shard("web", shardId, "rust")], "standard", {
      dataDir,
      adapters: { web: countingAdapter },
      shardCacheTtlMs: 60_000,
    });

    expect(calls).toHaveLength(0);
    expect(out[0]!.ok).toBe(true);
    expect(out[0]!.cacheHit).toBe(true);

    const onDisk = JSON.parse(await readFile(out[0]!.rawPath!, "utf8"));
    expect(onDisk.payload.label).toBe("cached");
  });

  it("bypasses cache when TTL is 0", async () => {
    const shardsDir = path.join(dataDir, "shards");
    await mkdir(shardsDir, { recursive: true });
    await writeFileSafe(
      path.join(shardsDir, "nocache.json"),
      JSON.stringify({ shardId: "nocache", source: "searxng", fetchedAt: new Date().toISOString(), payload: {} }),
    );

    const calls: string[] = [];
    const countingAdapter: ShardAdapter = {
      category: "web",
      async search(_q, _h, _d, outPath, _t) {
        calls.push(outPath);
        const id = path.basename(outPath, ".json");
        await writeFileSafe(
          outPath,
          JSON.stringify({
            shardId: id,
            source: "searxng",
            fetchedAt: new Date().toISOString(),
            payload: { ok: true },
          }),
        );
      },
    };

    const out = await dispatchShards([shard("web", "nocache", "x")], "standard", {
      dataDir,
      adapters: { web: countingAdapter },
      shardCacheTtlMs: 0,
    });

    expect(calls).toHaveLength(1);
    expect(out[0]!.cacheHit).toBeUndefined();
  });

  it("refreshes an artifact that is older than the cache TTL", async () => {
    const shardsDir = path.join(dataDir, "shards");
    await mkdir(shardsDir, { recursive: true });
    const stalePath = path.join(shardsDir, "stale.json");
    await writeFileSafe(
      stalePath,
      JSON.stringify({ shardId: "stale", source: "searxng", fetchedAt: new Date().toISOString(), payload: { ok: true } }),
    );
    // Touch mtime to 2 minutes ago.
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await utimes(stalePath, twoMinutesAgo, twoMinutesAgo);

    const calls: string[] = [];
    const countingAdapter: ShardAdapter = {
      category: "web",
      async search(_q, _h, _d, outPath, _t) {
        calls.push(outPath);
        const id = path.basename(outPath, ".json");
        await writeFileSafe(
          outPath,
          JSON.stringify({
            shardId: id,
            source: "searxng",
            fetchedAt: new Date().toISOString(),
            payload: { ok: true },
          }),
        );
      },
    };

    const out = await dispatchShards([shard("web", "stale", "x")], "standard", {
      dataDir,
      adapters: { web: countingAdapter },
      shardCacheTtlMs: 60_000,
    });

    expect(calls).toHaveLength(1);
    expect(out[0]!.cacheHit).toBeUndefined();
  });
});

describe("dispatcher: slugifyShardId", () => {
  it("lowercases and joins with hyphens", () => {
    expect(slugifyShardId("Rust vs Go")).toBe("rust-vs-go");
  });
  it("strips non-alphanumerics", () => {
    expect(slugifyShardId("foo & bar: hello!")).toBe("foo-bar-hello");
  });
  it("truncates long queries to 48 chars", () => {
    const long = "a".repeat(100);
    const s = slugifyShardId(long);
    expect(s.length).toBeLessThanOrEqual(48);
  });
  it("falls back to a random 8-char id for empty input", () => {
    const s = slugifyShardId("---");
    expect(s.length).toBeGreaterThan(0);
  });
});
