// =============================================================================
// Eyes-MCP — soft artifact validator tests
//
// The validator runs at the dispatcher boundary. Soft mode: a malformed
// artifact is logged as a warning but the shard is still marked ok=true.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateRawArtifact, validateAndLog } from "../validate-artifact.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), `eyes-validate-${Math.random().toString(36).slice(2, 8)}`));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeArtifact(contents: string | object): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, "a.json");
  await writeFile(p, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return p;
}

describe("validateRawArtifact", () => {
  it("returns ok for a well-formed searxng artifact", async () => {
    const p = await writeArtifact({
      shardId: "s1",
      source: "searxng",
      query: "x",
      fetchedAt: "2024-01-01T00:00:00Z",
      payload: { results: [] },
    });
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(true);
  });

  it("returns ok=false for non-JSON", async () => {
    const p = await writeArtifact("not json at all{");
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
  });

  it("returns ok=false for a top-level that isn't an object", async () => {
    const p = await writeArtifact(JSON.stringify("a string"));
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an object/);
  });

  it("returns ok=false when a required top-level field is missing", async () => {
    const p = await writeArtifact({ shardId: "s1", source: "searxng" }); // no fetchedAt
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fetchedAt/);
  });

  it("returns ok=false when a required field is empty", async () => {
    const p = await writeArtifact({ shardId: "s1", source: "", fetchedAt: "2024-01-01" });
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/source/);
  });

  it("returns ok=false for an unknown source id", async () => {
    const p = await writeArtifact({
      shardId: "s1",
      source: "made-up-source",
      fetchedAt: "2024-01-01",
      payload: {},
    });
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown source/);
  });

  it("returns ok=false when the payload field is missing", async () => {
    const p = await writeArtifact({
      shardId: "s1",
      source: "searxng",
      fetchedAt: "2024-01-01",
    });
    const r = await validateRawArtifact(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/payload/);
  });

  it("accepts every known SourceId", async () => {
    for (const source of [
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
    ]) {
      const p = await writeArtifact({
        shardId: "s1",
        source,
        fetchedAt: "2024-01-01",
        payload: { ok: true },
      });
      const r = await validateRawArtifact(p);
      expect(r.ok, `expected source ${source} to be valid`).toBe(true);
    }
  });

  it("returns ok=false when the file can't be read", async () => {
    const r = await validateRawArtifact(path.join(dir, "does-not-exist.json"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/read failed/);
  });
});

describe("validateAndLog (soft mode)", () => {
  it("logs a warning for a malformed artifact (does not throw)", async () => {
    const p = await writeArtifact("not json{");
    const warn = vi.fn();
    const result = await validateAndLog(p, "shard-7", { warn } as never);
    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const call = warn.mock.calls[0]!;
    expect(call[0]).toMatch(/artifact shape is unexpected/);
    const ctx = call[1] as { shardId: string; path: string; reason: string };
    expect(ctx.shardId).toBe("shard-7");
    expect(ctx.path).toBe(p);
    expect(ctx.reason).toMatch(/not valid JSON/);
  });

  it("does NOT log for a well-formed artifact", async () => {
    const p = await writeArtifact({
      shardId: "s1",
      source: "searxng",
      fetchedAt: "2024-01-01",
      payload: { results: [] },
    });
    const warn = vi.fn();
    const result = await validateAndLog(p, "s1", { warn } as never);
    expect(result.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the validation result to the caller (caller decides what to do)", async () => {
    const p = await writeArtifact("not json{");
    // The whole point of "soft" is that the caller (dispatcher) sees the
    // result but does NOT change shard.ok. This test pins that contract.
    const warn = vi.fn();
    const result = await validateAndLog(p, "s1", { warn } as never);
    expect(result.ok).toBe(false);
    // No throw. The function returns, the caller continues.
  });
});
