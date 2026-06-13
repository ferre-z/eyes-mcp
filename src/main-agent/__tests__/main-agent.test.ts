// =============================================================================
// Eyes-MCP — main agent orchestration tests (heuristic mode)
//
// MainAgent.research() is the public entry point. In heuristic mode it must:
//   * run decompose → dispatch → parse → review → synthesize
//   * produce a ResearchOutput with the right shape
//   * report an honest `mode: "heuristic"` when no LLM ran
//   * cap shards at maxShards
//   * cap iterations at maxIterations
//   * never throw on adapter failures (they become ok=false shards)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MainAgent, type MainAgentConfig } from "../index.js";
import { parseRawShards } from "../../parse/index.js";
import type { ShardAdapter } from "../../dispatcher/types.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), `eyes-maintest-${Math.random().toString(36).slice(2, 8)}`));
  await mkdir(path.join(dataDir, "shards"), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function failingAdapter(msg: string): ShardAdapter {
  return {
    category: "web",
    async search() {
      throw new Error(msg);
    },
  };
}

function chunkedAdapter(): ShardAdapter {
  return {
    category: "web",
    async search(query, _hint, _depth, outPath, _timeoutMs) {
      const { writeFile } = await import("node:fs/promises");
      const path_ = outPath;
      await writeFile(
        path_,
        JSON.stringify({
          shardId: path.basename(path_, ".json"),
          source: "searxng",
          query,
          fetchedAt: new Date().toISOString(),
          payload: {
            results: [
              { title: "Real result 1", url: "https://example.com/1", snippet: "First snippet of evidence." },
              { title: "Real result 2", url: "https://example.com/2", snippet: "Second snippet of evidence." },
            ],
          },
        }),
        "utf8",
      );
    },
  };
}

describe("MainAgent: heuristic mode end-to-end", () => {
  // Helper to build an agent wired up with the real parse layer. The
  // type lets callers override any field including the required ones
  // (parseRawShards), but our default uses the real one.
  function agent(overrides: Partial<MainAgentConfig> = {}): MainAgent {
    return new MainAgent({
      llm: null,
      dataDir,
      parseRawShards,
      adapters: { web: chunkedAdapter() },
      ...overrides,
    });
  }

  it("returns a ResearchOutput even when every adapter fails", async () => {
    const a = agent({ adapters: { web: failingAdapter("upstream down") } });
    const out = await a.research({
      prompt: "anything",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    expect(out.answer).toBeTruthy();
    expect(out.shards).toHaveLength(1);
    expect(out.shards[0]!.ok).toBe(false);
    expect(out.mode).toBe("heuristic");
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
  });

  it("returns an explicit no-evidence message when nothing was collected", async () => {
    const a = agent({ adapters: { web: failingAdapter("nope") } });
    const out = await a.research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    expect(out.answer).toMatch(/no evidence was found/i);
  });

  it("summarizes the collected chunks when at least one shard succeeded", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    expect(out.answer).toContain("Real result 1");
    expect(out.shards[0]!.chunkCount).toBeGreaterThan(0);
    expect(out.shards[0]!.ok).toBe(true);
  });

  it("caps shards at maxShards", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 2,
      maxIterations: 1,
    });
    expect(out.shards.length).toBeLessThanOrEqual(2);
  });

  it("reports an honest durationMs", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof out.durationMs).toBe("number");
  });

  it("iterations is at least 1 even if we return on the first review", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 3,
    });
    expect(out.iterations).toBe(1);
  });

  it("writes the shard artifact files under {dataDir}/shards", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    const shardId = out.shards[0]!.id;
    const onDisk = JSON.parse(
      await readFile(path.join(dataDir, "shards", `${shardId}.json`), "utf8"),
    );
    expect(onDisk.source).toBe("searxng");
  });

  it("respects a custom tokenBudget (does not crash if it's 0)", async () => {
    const a = agent({ tokenBudget: 0 });
    const out = await a.research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
    });
    expect(out).toBeTruthy();
  });

  it("re-formats the answer via synthesize when outputFormat=json", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
      outputFormat: "json",
    });
    // The review step returns a markdown-ish answer, but the caller asked
    // for JSON. We should round-trip through parse() cleanly.
    expect(() => JSON.parse(out.answer)).not.toThrow();
    const obj = JSON.parse(out.answer);
    expect(obj).toMatchObject({ answer: expect.any(String), key_points: expect.any(Array) });
  });

  it("re-formats the answer via synthesize when outputFormat=summary", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
      outputFormat: "summary",
    });
    // Summary format is a tight paragraph; should be short and not contain
    // markdown section headers like "### [web]".
    expect(out.answer).not.toContain("### [web]");
    expect(out.answer.length).toBeLessThan(400);
  });

  it("outputFormat=markdown leaves the review answer as-is (no re-format)", async () => {
    const out = await agent().research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
      outputFormat: "markdown",
    });
    // Default markdown keeps the review's "Findings for:" header.
    expect(out.answer).toContain("Findings for:");
  });

  it("outputFormat=json wraps the no-evidence message in a JSON envelope", async () => {
    const a = agent({ adapters: { web: failingAdapter("nope") } });
    const out = await a.research({
      prompt: "q",
      scope: ["web"],
      maxShards: 1,
      maxIterations: 1,
      outputFormat: "json",
    });
    expect(() => JSON.parse(out.answer)).not.toThrow();
    const obj = JSON.parse(out.answer);
    expect(obj.answer).toMatch(/no evidence was found/i);
    expect(obj.key_points).toEqual([]);
    expect(obj.sources).toEqual([]);
  });
});

describe("MainAgent: input validation", () => {
  function agent(overrides: Partial<MainAgentConfig> = {}): MainAgent {
    return new MainAgent({
      llm: null,
      dataDir,
      parseRawShards,
      adapters: { web: chunkedAdapter() },
      ...overrides,
    });
  }

  it("rejects an empty prompt", async () => {
    await expect(agent().research({ prompt: "", scope: ["web"], maxShards: 1 })).rejects.toThrow();
  });

  it("rejects maxShards > 20", async () => {
    await expect(agent().research({ prompt: "q", scope: ["web"], maxShards: 999 })).rejects.toThrow();
  });

  it("rejects maxIterations > 5", async () => {
    await expect(
      agent().research({ prompt: "q", scope: ["web"], maxShards: 1, maxIterations: 99 }),
    ).rejects.toThrow();
  });
});

describe("MainAgent: required config", () => {
  it("throws a clear error when parseRawShards is missing", () => {
    // The TS type already requires parseRawShards, but a `as any` cast at
    // a callsite could bypass that. The runtime guard catches the bypass.
    expect(() => {
      // @ts-expect-error — intentionally constructing without the required field
      new MainAgent({ llm: null, dataDir });
    }).toThrow(/requires `parseRawShards`/);
  });
});
