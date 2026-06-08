// =============================================================================
// Eyes-MCP — strip layer unit tests
//
// We mock node:fs/promises so the test never touches the real disk. The
// vi.mock factory has to be set up before any import of the module under
// test (vitest hoists vi.mock calls).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// Mock node:fs/promises. We control readFile / writeFile / mkdir from
// each test. The other helpers are no-op stubs.
vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
    access: vi.fn(),
  };
});

// Mock node:path.join to just use forward-slash concatenation so the
// tests are readable + cross-platform without touching OS separators.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    join: (...parts: string[]) => parts.filter((p) => p !== "").join("/"),
  };
});

// Import after mocks are set up.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stripShards } from "../strip.js";

const readFileMock = readFile as unknown as Mock;
const writeFileMock = writeFile as unknown as Mock;
const mkdirMock = mkdir as unknown as Mock;

beforeEach(() => {
  readFileMock.mockReset();
  writeFileMock.mockReset();
  mkdirMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
});

/** Build a SearXNG-shaped raw artifact with a long, varied body. */
function makeRaw(): string {
  return JSON.stringify({
    shardId: "web-abc",
    source: "searxng",
    query: "vitest",
    fetchedAt: "2026-01-01T00:00:00Z",
    payload: {
      results: [
        { title: "Vitest | A blazing-fast unit test framework", url: "https://vitest.dev/" },
        { title: "Getting started", url: "https://vitest.dev/guide/" },
      ],
      content:
        "Vitest is a fast unit test framework. " +
        "Navigation. " +
        "All rights reserved. " +
        "This is the actual content that should be preserved. ".repeat(20),
    },
  });
}

describe("stripShards", () => {
  it("writes a stripped file and reports correct stats for a successful shard", async () => {
    const raw = makeRaw();
    readFileMock.mockResolvedValue(raw);

    const results = await stripShards(
      [{ shardId: "web-abc", ok: true, rawPath: "/tmp/web-abc.json" }],
      { depth: "quick", dataDir: "/tmp/data" },
    );

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.shardId).toBe("web-abc");
    expect(r.cleanedPath).toBe("/tmp/data/shards/web-abc.stripped.txt");
    expect(r.bytesIn).toBe(Buffer.byteLength(raw, "utf8"));
    expect(r.bytesOut).toBeGreaterThan(0);
    expect(r.droppedRatio).toBeGreaterThanOrEqual(0);
    expect(r.droppedRatio).toBeLessThanOrEqual(1);

    // mkdir recursive was called with the shards directory.
    expect(mkdirMock).toHaveBeenCalledWith("/tmp/data/shards", { recursive: true });
    // writeFile was called once with the cleaned output.
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [pathArg, dataArg] = writeFileMock.mock.calls[0] as [string, string];
    expect(pathArg).toBe("/tmp/data/shards/web-abc.stripped.txt");
    expect(typeof dataArg).toBe("string");
    expect(dataArg.length).toBeGreaterThan(0);
  });

  it("quick, standard, deep produce different stripped outputs", async () => {
    const raw = makeRaw();

    // For each depth, run the stripper and capture what was written.
    const outputs: Record<string, string> = {};
    for (const depth of ["quick", "standard", "deep"] as const) {
      readFileMock.mockReset();
      writeFileMock.mockReset();
      readFileMock.mockResolvedValue(raw);
      let captured = "";
      writeFileMock.mockImplementation(async (_p: string, data: string) => {
        captured = data;
      });

      await stripShards(
        [{ shardId: "web-abc", ok: true, rawPath: "/tmp/web-abc.json" }],
        { depth, dataDir: "/tmp/data" },
      );
      outputs[depth] = captured;
    }

    // quick preserves the most bytes — it does not run nav/footer drop
    // or sentence dedup. standard does nav/footer drop. deep additionally
    // dedupes frequent sentences.
    const quickBytes = Buffer.byteLength(outputs["quick"] ?? "", "utf8");
    const standardBytes = Buffer.byteLength(outputs["standard"] ?? "", "utf8");
    const deepBytes = Buffer.byteLength(outputs["deep"] ?? "", "utf8");

    expect(quickBytes).toBeGreaterThan(standardBytes);
    expect(standardBytes).toBeGreaterThanOrEqual(deepBytes);
  });

  it("quick depth is the least aggressive (most text preserved)", async () => {
    const raw = makeRaw();
    readFileMock.mockResolvedValue(raw);

    // Capture outputs from all three depths.
    const outputs: Record<string, string> = {};
    writeFileMock.mockImplementation(async (_p: string, data: string) => {
      // We only care about the latest write for the same path.
      const path = (writeFileMock.mock.calls[writeFileMock.mock.calls.length - 1] as [string, string])[0];
      outputs[path] = data;
    });

    for (const depth of ["quick", "standard", "deep"] as const) {
      await stripShards(
        [{ shardId: "web-abc", ok: true, rawPath: "/tmp/web-abc.json" }],
        { depth, dataDir: "/tmp/data" },
      );
    }

    // Find each depth's output. The path doesn't include depth, but we ran
    // them in order: quick, standard, deep — the last write wins.
    // So we need to re-run individually to disambiguate.
    const perDepth: Record<string, string> = {};
    for (const depth of ["quick", "standard", "deep"] as const) {
      readFileMock.mockReset();
      writeFileMock.mockReset();
      readFileMock.mockResolvedValue(raw);
      let captured = "";
      writeFileMock.mockImplementation(async (_p: string, data: string) => {
        captured = data;
      });
      await stripShards(
        [{ shardId: "web-abc", ok: true, rawPath: "/tmp/web-abc.json" }],
        { depth, dataDir: "/tmp/data" },
      );
      perDepth[depth] = captured;
    }

    const quickBytes = Buffer.byteLength(perDepth["quick"] ?? "", "utf8");
    const standardBytes = Buffer.byteLength(perDepth["standard"] ?? "", "utf8");
    const deepBytes = Buffer.byteLength(perDepth["deep"] ?? "", "utf8");

    // The ordering must hold: quick is the largest, deep is the smallest.
    expect(quickBytes).toBeGreaterThanOrEqual(standardBytes);
    expect(standardBytes).toBeGreaterThanOrEqual(deepBytes);
    expect(quickBytes).toBeGreaterThan(deepBytes);
  });

  it("failed shards (ok=false) return zeroed-out stats", async () => {
    const results = await stripShards(
      [
        { shardId: "a", ok: false, error: "boom" },
        { shardId: "b", ok: false },
      ],
      { depth: "standard", dataDir: "/tmp/data" },
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.bytesIn).toBe(0);
      expect(r.bytesOut).toBe(0);
      expect(r.droppedRatio).toBe(0);
      expect(r.cleanedPath).toBe("");
    }
    // readFile should never be called for failed shards.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("shards with ok=true but missing rawPath return zeroed-out stats", async () => {
    const results = await stripShards(
      [{ shardId: "c", ok: true /* no rawPath */ }],
      { depth: "standard", dataDir: "/tmp/data" },
    );
    expect(results[0]!.bytesIn).toBe(0);
    expect(results[0]!.bytesOut).toBe(0);
    expect(results[0]!.droppedRatio).toBe(0);
  });
});
