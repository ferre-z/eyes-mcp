// =============================================================================
// Eyes-MCP — chunk layer unit tests
//
// The chunk layer reads the raw artifact + the stripped text file (which
// the strip layer wrote one phase earlier) and turns them into a
// ParsedShard. We mock node:fs/promises and node:path to keep everything
// in-process.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

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

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    join: (...parts: string[]) => parts.filter((p) => p !== "").join("/"),
  };
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chunkShards } from "../chunk.js";

const readFileMock = readFile as unknown as Mock;
const mkdirMock = mkdir as unknown as Mock;
const writeFileMock = writeFile as unknown as Mock;

beforeEach(() => {
  readFileMock.mockReset();
  mkdirMock.mockReset();
  writeFileMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
});

/** A SearXNG-shaped raw artifact used by the chunk layer's extractMeta. */
function makeSearxngRaw(opts: {
  shardId?: string;
  source?: string;
  query?: string;
  results?: Array<{ title?: string; url?: string; content?: string }>;
}): string {
  return JSON.stringify({
    shardId: opts.shardId ?? "web-x",
    source: opts.source ?? "searxng",
    query: opts.query ?? "vitest",
    fetchedAt: "2026-01-01T00:00:00Z",
    payload: {
      results: opts.results ?? [
        { title: "Vitest", url: "https://vitest.dev/" },
        { title: "Guide", url: "https://vitest.dev/guide/" },
      ],
    },
  });
}

/**
 * Programmable readFile mock: returns `raw` for the raw artifact, and
 * `stripped` for the stripped text file. Falls back to the raw for the
 * stripped file if `stripped` is undefined.
 */
function programReads(opts: { raw: string; stripped?: string }): void {
  const strippedPath = "/tmp/data/shards/web-x.stripped.txt";
  readFileMock.mockImplementation(async (p: string) => {
    if (p === strippedPath) {
      if (opts.stripped !== undefined) return opts.stripped;
      throw new Error("ENOENT");
    }
    return opts.raw;
  });
}

describe("chunkShards", () => {
  it("a SearXNG-shaped payload produces chunks with url set", async () => {
    const raw = makeSearxngRaw({});
    const stripped = [
      "Vitest is a blazing-fast unit test framework powered by Vite.",
      "",
      "It works with TypeScript, JSX, and many other frontend toolchains out of the box.",
    ].join("\n");
    programReads({ raw, stripped });

    const parsed = await chunkShards(
      [{ shardId: "web-x", ok: true, rawPath: "/tmp/raw/web-x.json" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 10 },
    );

    expect(parsed).toHaveLength(1);
    const shard = parsed[0]!;
    expect(shard.shardId).toBe("web-x");
    expect(shard.source).toBe("web");
    expect(shard.chunks.length).toBeGreaterThan(0);
    for (const c of shard.chunks) {
      // url is set when there's a URL in the meta
      expect(c.url).toBe("https://vitest.dev/");
      expect(typeof c.text).toBe("string");
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  it("code blocks (```...```) are kept intact as single chunks", async () => {
    const raw = makeSearxngRaw({});
    const stripped = [
      "Some prose before the code block.",
      "",
      "```ts",
      "import { test, expect } from 'vitest';",
      "test('hello', () => {",
      "  expect(1 + 1).toBe(2);",
      "});",
      "```",
      "",
      "Some prose after.",
    ].join("\n");
    programReads({ raw, stripped });

    const parsed = await chunkShards(
      [{ shardId: "web-x", ok: true, rawPath: "/tmp/raw/web-x.json" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 10 },
    );

    const shard = parsed[0]!;
    // We should have at least one chunk whose text is a code block.
    const codeChunk = shard.chunks.find((c) => c.text.includes("```ts"));
    expect(codeChunk).toBeDefined();
    // The code block should be preserved intact.
    expect(codeChunk!.text).toContain("import { test, expect } from 'vitest';");
    expect(codeChunk!.text).toContain("```");
  });

  it("chunks over 500 tokens get split by sentence", async () => {
    const raw = makeSearxngRaw({});
    // Build a single paragraph with > 500 tokens (~ > 2000 chars).
    // approximateTokens = ceil(len/4) so 2001 chars -> 501 tokens.
    // Use DISTINCT sentences so the simhash dedup doesn't collapse them.
    const longPara = Array.from({ length: 100 }, (_, i) =>
      `Sentence number ${i + 1} of the long paragraph for chunk splitting test.`,
    ).join(" ");
    expect(approximateTokens(longPara)).toBeGreaterThan(500);
    programReads({ raw, stripped: longPara });

    const parsed = await chunkShards(
      [{ shardId: "web-x", ok: true, rawPath: "/tmp/raw/web-x.json" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 100 },
    );

    const shard = parsed[0]!;
    expect(shard.chunks.length).toBeGreaterThan(1);
    // Each chunk should be non-empty.
    for (const c of shard.chunks) {
      const trimmed = c.text.trim();
      expect(trimmed.length).toBeGreaterThan(0);
    }
  });

  it("duplicate chunks (simhash distance < 5) are dropped within a shard", async () => {
    const raw = makeSearxngRaw({});
    // Two identical paragraphs separated by blank line.
    const para =
      "This is a paragraph that should appear multiple times in the shard. " +
      "It contains enough words to be a real chunk and to produce a stable simhash. " +
      "Repeating it twice should result in only one chunk being kept after dedup.";
    const stripped = [para, "", para].join("\n");
    programReads({ raw, stripped });

    const parsed = await chunkShards(
      [{ shardId: "web-x", ok: true, rawPath: "/tmp/raw/web-x.json" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 50 },
    );

    const shard = parsed[0]!;
    // Dedup should have dropped the second copy — only 1 chunk remains.
    expect(shard.chunks).toHaveLength(1);
  });

  it("maxChunksPerShard cap is respected", async () => {
    const raw = makeSearxngRaw({});
    // Build many distinct paragraphs.
    const paras = Array.from({ length: 20 }, (_, i) =>
      `Paragraph number ${i} with a unique token${i} to keep simhash distinct.`,
    );
    const stripped = paras.join("\n\n");
    programReads({ raw, stripped });

    const cap = 3;
    const parsed = await chunkShards(
      [{ shardId: "web-x", ok: true, rawPath: "/tmp/raw/web-x.json" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: cap },
    );

    const shard = parsed[0]!;
    expect(shard.chunks.length).toBeLessThanOrEqual(cap);
  });

  it("failed shards (ok=false) return a ParsedShard with empty chunks", async () => {
    const parsed = await chunkShards(
      [{ shardId: "bad", ok: false, error: "adapter exploded" }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 10 },
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.chunks).toEqual([]);
    // The summary should mention the error.
    expect(parsed[0]!.summary).toContain("adapter exploded");
    // readFile should not have been called for failed shards.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("shards with ok=true but missing rawPath return empty chunks", async () => {
    const parsed = await chunkShards(
      [{ shardId: "noraw", ok: true /* no rawPath */ }],
      { depth: "standard", dataDir: "/tmp/data", maxChunksPerShard: 10 },
    );
    expect(parsed[0]!.chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// local helper (we re-implement approximateTokens here to avoid an import
// in the test file — keeps the assertion in one place)
// ---------------------------------------------------------------------------

function approximateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}
