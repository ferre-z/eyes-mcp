// =============================================================================
// Eyes-MCP — review step tests
//
// review() returns either { type: "return", answer } or
// { type: "refine", newShards, reason }. In heuristic mode it never
// returns "refine" when there's any content; in LLM mode it does what
// the model says. We mock LLMClient to control the LLM path.
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { review } from "../review.js";
import type { LLMClient } from "../../llm/client.js";
import type { ParsedShard, Source } from "../../dispatcher/types.js";

function emptyLLM(): LLMClient {
  return {
    isConfigured: true,
    model: "test",
    generate: vi.fn(),
  };
}

function shard(id: string, source: ParsedShard["source"] = "web", chunkCount = 2): ParsedShard {
  return {
    shardId: id,
    source,
    summary: `summary for ${id}`,
    chunks: Array.from({ length: chunkCount }, (_, i) => ({
      text: `chunk ${i} of ${id}`,
      charOffset: 0,
      tokenCount: 5,
    })),
  };
}

const sources: ReadonlyArray<Source> = [
  { category: "web" },
  { category: "github" },
];

describe("review (heuristic mode, no LLM)", () => {
  it("returns the evidence summary when at least one shard has chunks", async () => {
    const out = await review(
      [shard("a"), shard("b")],
      "what is x?",
      sources,
      null,
      { remainingIterations: 1, maxShards: 5, usedTokens: 0, tokenBudget: 1000 },
    );
    expect(out.type).toBe("return");
    if (out.type === "return") {
      expect(out.answer).toContain("Findings for: what is x?");
      expect(out.answer).toContain("[web] a");
      expect(out.answer).toContain("[web] b");
    }
  });

  it("returns refine with a web-retry shard when nothing produced chunks but iterations remain", async () => {
    const empty: ParsedShard = { shardId: "e", source: "web", summary: "nothing", chunks: [] };
    const out = await review(
      [empty],
      "hard question",
      sources,
      null,
      { remainingIterations: 1, maxShards: 5, usedTokens: 0, tokenBudget: 1000 },
    );
    expect(out.type).toBe("refine");
    if (out.type === "refine") {
      expect(out.newShards).toHaveLength(1);
      expect(out.newShards[0]!.source.category).toBe("web");
      expect(out.reason).toBeTruthy();
    }
  });

  it("returns a polite no-evidence message when nothing produced chunks and no iterations left", async () => {
    const empty: ParsedShard = { shardId: "e", source: "web", summary: "nothing", chunks: [] };
    const out = await review(
      [empty],
      "hard question",
      sources,
      null,
      { remainingIterations: 0, maxShards: 5, usedTokens: 0, tokenBudget: 1000 },
    );
    expect(out.type).toBe("return");
    if (out.type === "return") {
      expect(out.answer).toMatch(/no evidence was found/i);
    }
  });

  it("ignores zero-chunk shards when building the summary", async () => {
    const out = await review(
      [shard("a", "web", 2), { shardId: "b", source: "web", summary: "empty", chunks: [] }],
      "q",
      sources,
      null,
      { remainingIterations: 0, maxShards: 5, usedTokens: 0, tokenBudget: 1000 },
    );
    if (out.type === "return") {
      expect(out.answer).toContain("a");
      expect(out.answer).not.toContain("### [web] b");
    }
  });
});

describe("review (LLM mode)", () => {
  it("returns the LLM's answer when decision=return", async () => {
    const llm = emptyLLM();
    (llm.generate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: JSON.stringify({ decision: "return", answer: "the final answer" }),
      tokensIn: 1,
      tokensOut: 1,
      structured: { decision: "return", answer: "the final answer" },
    });
    const out = await review([shard("a")], "q", sources, llm, {
      remainingIterations: 0,
      maxShards: 5,
      usedTokens: 0,
      tokenBudget: 1000,
    });
    expect(out.type).toBe("return");
    if (out.type === "return") expect(out.answer).toBe("the final answer");
  });

  it("returns new shards when decision=refine", async () => {
    const llm = emptyLLM();
    (llm.generate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: JSON.stringify({
        decision: "refine",
        reason: "need github",
        newShards: [{ id: "g1", query: "q", source: { category: "github" }, why: "x" }],
      }),
      tokensIn: 1,
      tokensOut: 1,
      structured: {
        decision: "refine",
        reason: "need github",
        newShards: [{ id: "g1", query: "q", source: { category: "github" }, why: "x" }],
      },
    });
    const out = await review([shard("a")], "q", sources, llm, {
      remainingIterations: 1,
      maxShards: 5,
      usedTokens: 0,
      tokenBudget: 1000,
    });
    expect(out.type).toBe("refine");
    if (out.type === "refine") {
      expect(out.newShards[0]!.source.category).toBe("github");
      expect(out.reason).toContain("github");
    }
  });

  it("filters 'general' out of refine shards and falls back to return when none survive", async () => {
    const llm = emptyLLM();
    (llm.generate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: JSON.stringify({
        decision: "refine",
        reason: "x",
        newShards: [{ id: "g1", query: "q", source: { category: "general" }, why: "x" }],
      }),
      tokensIn: 1,
      tokensOut: 1,
      structured: {
        decision: "refine",
        reason: "x",
        newShards: [{ id: "g1", query: "q", source: { category: "general" }, why: "x" }],
      },
    });
    const out = await review([shard("a")], "q", sources, llm, {
      remainingIterations: 1,
      maxShards: 5,
      usedTokens: 0,
      tokenBudget: 1000,
    });
    // All "general" shards were filtered, so we fall back to heuristic return.
    expect(out.type).toBe("return");
  });

  it("falls back to heuristic when the LLM throws", async () => {
    const llm = emptyLLM();
    (llm.generate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("net down"));
    const out = await review([shard("a")], "q", sources, llm, {
      remainingIterations: 0,
      maxShards: 5,
      usedTokens: 0,
      tokenBudget: 1000,
    });
    expect(out.type).toBe("return");
  });

  it("falls back to heuristic when the LLM returns garbage that doesn't match the schema", async () => {
    const llm = emptyLLM();
    (llm.generate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "not json at all",
      tokensIn: 0,
      tokensOut: 0,
    });
    const out = await review([shard("a")], "q", sources, llm, {
      remainingIterations: 0,
      maxShards: 5,
      usedTokens: 0,
      tokenBudget: 1000,
    });
    expect(out.type).toBe("return");
  });
});
