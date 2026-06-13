// =============================================================================
// Eyes-MCP — parse layer end-to-end tests
//
// parseRawShards runs strip + chunk. We feed it real raw artifacts (the
// JSON envelopes adapters write) and check the resulting ParsedShard[].
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRawShards } from "../index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = path.join(tmpdir(), `eyes-parse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(path.join(dataDir, "shards"), { recursive: true });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeArtifact(shardId: string, payload: Record<string, unknown>): Promise<string> {
  const p = path.join(dataDir, "shards", `${shardId}.json`);
  await writeFile(p, JSON.stringify({ shardId, source: "searxng", query: "x", fetchedAt: "2024-01-01T00:00:00Z", payload }, null, 2));
  return p;
}

describe("parse: end-to-end", () => {
  it("emits a failed ParsedShard for an ok=false result", async () => {
    const out = await parseRawShards(
      [{ shardId: "f1", ok: false, error: "upstream 500" }],
      { dataDir, maxChunksPerShard: 5, depth: "standard" },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.chunks).toEqual([]);
    expect(out[0]!.summary).toContain("upstream 500");
  });

  it("turns a SearXNG-style raw artifact into chunks with a url", async () => {
    const rawPath = await writeArtifact("s1", {
      results: [
        { title: "First result", url: "https://example.com/1", snippet: "alpha bravo charlie" },
        { title: "Second result", url: "https://example.com/2", snippet: "delta echo foxtrot" },
      ],
    });
    const out = await parseRawShards(
      [{ shardId: "s1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 10, depth: "standard" },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.chunks.length).toBeGreaterThan(0);
    // Every chunk should carry a url (from the first result).
    for (const c of out[0]!.chunks) {
      expect(c.url).toMatch(/^https:\/\/example\.com/);
    }
  });

  it("writes the stripped .txt sibling the chunk layer consumes", async () => {
    const rawPath = await writeArtifact("s2", {
      results: [{ title: "x", url: "https://e.test/1", snippet: "alpha" }],
    });
    await parseRawShards(
      [{ shardId: "s2", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 5, depth: "standard" },
    );
    const stripped = path.join(dataDir, "shards", "s2.stripped.txt");
    const exists = await readFile(stripped, "utf8");
    expect(exists.length).toBeGreaterThan(0);
  });

  it("respects depth=quick (no nav/footer filtering)", async () => {
    // The raw artifact's flatten step doesn't include nav words by default;
    // we just verify the depth knob doesn't throw.
    const rawPath = await writeArtifact("q1", { results: [{ title: "x", url: "https://e.test/1", snippet: "hello" }] });
    const out = await parseRawShards(
      [{ shardId: "q1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 5, depth: "quick" },
    );
    expect(out[0]!.chunks.length).toBeGreaterThan(0);
  });

  it("respects depth=deep (sentence-level dedup for repeated sentences)", async () => {
    // The strip layer collapses arrays via flattenObject before chunk layer
    // sees them. With depth=deep, repeated sentences inside a single chunk
    // should also be deduped.
    const repeated = "Same sentence. ".repeat(10);
    const rawPath = await writeArtifact("d1", {
      // body gets serialized into a "body: <json>" line by flattenObject.
      // The single chunk will then be passed through dedupFrequentSentences.
      body: repeated,
    });
    const out = await parseRawShards(
      [{ shardId: "d1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 50, depth: "deep" },
    );
    expect(out).toHaveLength(1);
    const totalText = out[0]!.chunks.map((c) => c.text).join(" ");
    const occurrences = (totalText.match(/Same sentence\./g) ?? []).length;
    expect(occurrences).toBeLessThan(10);
  });

  it("SearXNG results become one paragraph per result (via the per-adapter summarizer)", async () => {
    // The strip layer used to flatten SearXNG-style { results: [...] }
    // arrays into a single line via flattenObject (with "|" joiners). After
    // the per-adapter summarizer refactor, each result becomes its own
    // paragraph separated by a blank line, so the chunk layer produces
    // one chunk per result.
    const rawPath = await writeArtifact("c1", {
      results: [
        { title: "First result", url: "https://e.test/1", snippet: "alpha bravo charlie delta echo foxtrot golf hotel" },
        { title: "Second result", url: "https://e.test/2", snippet: "kilo lima mike november oscar papa quebec romeo" },
        { title: "Third result", url: "https://e.test/3", snippet: "sierra tango uniform victor whiskey xray yankee zulu" },
      ],
    });
    const out = await parseRawShards(
      [{ shardId: "c1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 10, depth: "standard" },
    );
    expect(out[0]!.chunks.length).toBe(3);
    // Each chunk should carry the URL of its result.
    expect(out[0]!.chunks[0]!.url).toBe("https://e.test/1");
    expect(out[0]!.chunks[1]!.url).toBe("https://e.test/2");
    expect(out[0]!.chunks[2]!.url).toBe("https://e.test/3");
  });

  it("skips paragraphs that hash to the same simhash (within one shard)", async () => {
    // The per-adapter summarizer produces one paragraph per SearXNG result.
    // To trigger simhash dedup, the paragraphs need to be near-duplicates
    // by token. We give all 5 the same URL prefix (only the path index
    // differs) and the same long snippet, so the dominant tokens overlap
    // and the hamming distance between simhashes stays < 5.
    const sharedSnippet =
      "The quick brown fox jumps over the lazy dog while the wind whispers through the meadow.";
    const rawPath = await writeArtifact("simdup", {
      results: Array.from({ length: 5 }, (_, i) => ({
        title: "Same title everywhere",
        url: `https://example.com/result/${i}`,
        snippet: sharedSnippet,
      })),
    });
    const out = await parseRawShards(
      [{ shardId: "simdup", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 50, depth: "standard" },
    );
    expect(out[0]!.chunks.length).toBe(1);
  });

  it("maps the source id 'arxiv' to category 'arxiv' on the parsed shard", async () => {
    const rawPath = path.join(dataDir, "shards", "a1.json");
    await writeFile(
      rawPath,
      JSON.stringify({
        shardId: "a1",
        source: "arxiv",
        query: "x",
        fetchedAt: "2024-01-01T00:00:00Z",
        payload: { items: [{ title: "paper", summary: "abstract" }] },
      }),
    );
    const out = await parseRawShards(
      [{ shardId: "a1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 5, depth: "standard" },
    );
    expect(out[0]!.source).toBe("arxiv");
  });

  it("maps the source id 'searxng' to category 'web' on the parsed shard", async () => {
    const rawPath = await writeArtifact("sx1", { results: [{ title: "x", url: "https://e/1", snippet: "y" }] });
    const out = await parseRawShards(
      [{ shardId: "sx1", ok: true, rawPath }],
      { dataDir, maxChunksPerShard: 5, depth: "standard" },
    );
    expect(out[0]!.source).toBe("web");
  });
});
