// =============================================================================
// Eyes-MCP — decompose heuristic tests
//
// The heuristic is the only path that runs without an LLM. It must:
//   - emit exactly one shard for a single-source scope
//   - emit one shard per source for multi-source scope
//   - cap at maxShards
//   - produce the [heuristic] marker so the main agent can detect fallback
//   - expand "general" to the standard set
// =============================================================================

import { describe, it, expect } from "vitest";
import { decomposeHeuristic } from "../decompose-heuristic.js";

describe("decompose heuristic", () => {
  it("emits exactly one shard when scope has a single category", () => {
    const out = decomposeHeuristic("what is rust?", [{ category: "github" }], 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.category).toBe("github");
    expect(out[0]!.query).toBe("what is rust?");
  });

  it("emits a shard per requested source in multi-source scope when web isn't competing", () => {
    // cap=4: 1 web (always first) + 3 explicit sources
    const out = decomposeHeuristic("x", [
      { category: "github" },
      { category: "reddit" },
      { category: "arxiv" },
    ], 4);
    const cats = out.map((s) => s.source.category);
    expect(cats).toContain("web");
    expect(cats).toContain("github");
    expect(cats).toContain("reddit");
    expect(cats).toContain("arxiv");
  });

  it("emits a shard per requested source in multi-source scope when cap is tight", () => {
    // cap=3 with 3 explicit sources: web wins the first slot, then 2 of the 3.
    // arxiv is dropped (the last in the explicit list).
    const out = decomposeHeuristic("x", [
      { category: "github" },
      { category: "reddit" },
      { category: "arxiv" },
    ], 3);
    const cats = out.map((s) => s.source.category);
    expect(cats).toContain("web");
    expect(cats.length).toBe(3);
  });

  it("fills remaining capacity with web shards when explicit sources don't use it all", () => {
    const out = decomposeHeuristic("x", [
      { category: "github" },
      { category: "reddit" },
    ], 5);
    // 2 explicit + up to 2 web reformulations = up to 4 shards; at least one web shard.
    const cats = out.map((s) => s.source.category);
    expect(cats).toContain("github");
    expect(cats).toContain("reddit");
    expect(cats.filter((c) => c === "web").length).toBeGreaterThanOrEqual(1);
  });

  it("expands general to the standard set", () => {
    const out = decomposeHeuristic("x", [{ category: "general" }], 20);
    const cats = out.map((s) => s.source.category);
    expect(cats).toContain("web");
    expect(cats).toContain("github");
    expect(cats).toContain("reddit");
    expect(cats).toContain("hackernews");
    expect(cats).toContain("arxiv");
    expect(cats).toContain("wikipedia");
    expect(cats).toContain("youtube");
  });

  it("expands empty scope to the standard set", () => {
    const out = decomposeHeuristic("x", [], 20);
    expect(out.length).toBeGreaterThanOrEqual(7);
  });

  it("caps at maxShards", () => {
    const out = decomposeHeuristic("x", [], 3);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("always returns at least one shard", () => {
    const out = decomposeHeuristic("x", [], 1);
    expect(out.length).toBe(1);
  });

  it("marks every shard with the [heuristic] why prefix", () => {
    const out = decomposeHeuristic("x", [
      { category: "github" },
      { category: "reddit" },
    ], 5);
    for (const s of out) {
      expect(s.why.startsWith("[heuristic]")).toBe(true);
    }
  });

  it("generates deterministic ids for a stable query", () => {
    const a = decomposeHeuristic("hello world", [{ category: "github" }], 5);
    const b = decomposeHeuristic("hello world", [{ category: "github" }], 5);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it("includes the source category in the shard id", () => {
    const out = decomposeHeuristic("x", [{ category: "wikipedia" }], 5);
    expect(out[0]!.id).toMatch(/^wikipedia-/);
  });

  it("propagates hint to the why field when present in a multi-source scope", () => {
    // The single-source branch doesn't currently include the hint in `why`,
    // but the multi-source branch does. This is a regression test for the
    // multi-source path.
    const out = decomposeHeuristic("x", [
      { category: "reddit", hint: "rustlang" },
      { category: "github" },
    ], 2);
    const redditShard = out.find((s) => s.source.category === "reddit")!;
    expect(redditShard.why).toContain("(rustlang)");
  });

  it("respects a maxShards of 0 by clamping to 1", () => {
    const out = decomposeHeuristic("x", [{ category: "github" }], 0);
    expect(out.length).toBe(1);
  });

  // ---- Regression: maxShards=1 should pick web, not github ---------------

  it("picks web first when maxShards=1 + general scope", () => {
    // Bug: previously, this returned a github shard (the first non-web in
    // STANDARD_CATEGORIES), because the web branch ran AFTER the others
    // branch and the cap was already hit. Web is the broadest source and
    // should win the single slot.
    const out = decomposeHeuristic("x", [], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.category).toBe("web");
  });

  it("picks web first when maxShards=1 + explicit [general] scope", () => {
    const out = decomposeHeuristic("x", [{ category: "general" }], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.category).toBe("web");
  });

  it("picks web first when maxShards=1 + explicit web+others scope", () => {
    const out = decomposeHeuristic("x", [
      { category: "web" },
      { category: "github" },
      { category: "reddit" },
    ], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.category).toBe("web");
  });

  it("with maxShards=2 + general scope: web first, then one other", () => {
    const out = decomposeHeuristic("x", [], 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.source.category).toBe("web");
    // The second shard is the first non-web in STANDARD_CATEGORIES, which is github.
    expect(out[1]!.source.category).toBe("github");
  });

  it("with maxShards=N + general scope: web first, then others, with a second web reformulation when hasWeb is implicit", () => {
    // scope=[]  →  normalized = all 7 standard categories  →  hasWeb=true
    // cap=8  →  1 web + 6 others + 1 second-web-reformulation = 8
    const out = decomposeHeuristic("x", [], 8);
    expect(out).toHaveLength(8);
    expect(out[0]!.source.category).toBe("web");
    // All 6 non-web standard categories should be present.
    const cats = out.map((s) => s.source.category);
    for (const c of ["github", "reddit", "hackernews", "youtube", "arxiv", "wikipedia"]) {
      expect(cats).toContain(c);
    }
    // Exactly 2 web shards (one first, one reformulation).
    expect(cats.filter((c) => c === "web").length).toBe(2);
  });

  it("with cap=1 + scope=[github] only (no web): honors the explicit single source", () => {
    // The single-source branch always wins; maxShards=1 + non-web scope
    // still picks the one requested source.
    const out = decomposeHeuristic("x", [{ category: "github" }], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.source.category).toBe("github");
  });
});
