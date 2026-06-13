// =============================================================================
// Eyes-MCP — synthesize step tests
//
// synthesize() is the final-answer step. It must:
//   - return an explicit "no evidence" message if every shard is empty
//   - use heuristic synthesis when no LLM is configured
//   - respect outputFormat (markdown / json / summary)
//   - sanitize leaked agent self-talk from LLM output
// =============================================================================

import { describe, it, expect, vi } from "vitest";
import { synthesize } from "../synthesize.js";
import type { LLMClient } from "../../llm/client.js";
import type { ParsedShard } from "../../dispatcher/types.js";

function llmClient(behavior: "ok" | "throw" | "empty"): LLMClient {
  return {
    isConfigured: true,
    model: "test",
    generate: vi.fn().mockImplementation(async () => {
      if (behavior === "throw") throw new Error("net down");
      if (behavior === "empty") return { text: "", tokensIn: 0, tokensOut: 0 };
      return { text: "the model wrote this answer", tokensIn: 1, tokensOut: 1 };
    }),
  };
}

function chunkedShard(id: string, source: ParsedShard["source"] = "web"): ParsedShard {
  return {
    shardId: id,
    source,
    summary: `summary ${id}`,
    chunks: [
      { text: "alpha", charOffset: 0, tokenCount: 1 },
      { text: "beta", charOffset: 5, tokenCount: 1 },
    ],
  };
}

function emptyShard(id: string): ParsedShard {
  return { shardId: id, source: "web", summary: "empty", chunks: [] };
}

describe("synthesize: empty-evidence short-circuit", () => {
  it("returns an explicit no-evidence message when no shard has chunks", async () => {
    const out = await synthesize(
      [emptyShard("a"), emptyShard("b")],
      "q",
      llmClient("ok"),
      { outputFormat: "markdown" },
    );
    expect(out).toMatch(/^No evidence was found across the requested sources/);
  });

  it("does NOT call the LLM when there is no evidence", async () => {
    const llm = llmClient("ok");
    await synthesize([emptyShard("a")], "q", llm, { outputFormat: "markdown" });
    expect(llm.generate).not.toHaveBeenCalled();
  });
});

describe("synthesize: LLM path", () => {
  it("returns the LLM's text on a clean response", async () => {
    const out = await synthesize([chunkedShard("a")], "q", llmClient("ok"), { outputFormat: "markdown" });
    expect(out).toBe("the model wrote this answer");
  });

  it("falls back to heuristic when the LLM throws", async () => {
    const out = await synthesize([chunkedShard("a")], "q", llmClient("throw"), { outputFormat: "markdown" });
    // Heuristic markdown starts with "# Findings:"
    expect(out.startsWith("# Findings:")).toBe(true);
  });

  it("falls back to heuristic when the LLM returns empty text", async () => {
    const out = await synthesize([chunkedShard("a")], "q", llmClient("empty"), { outputFormat: "markdown" });
    expect(out.startsWith("# Findings:")).toBe(true);
  });

  it("sanitizes <thought> blocks from the LLM output", async () => {
    const llm: LLMClient = {
      isConfigured: true,
      model: "test",
      generate: vi.fn().mockResolvedValueOnce({
        text: "<thought>internal monologue</thought>\n\nReal answer here.",
        tokensIn: 0,
        tokensOut: 0,
      }),
    };
    const out = await synthesize([chunkedShard("a")], "q", llm, { outputFormat: "markdown" });
    expect(out).not.toContain("<thought>");
    expect(out).toBe("Real answer here.");
  });

  it("sanitizes // scratch lines from the LLM output", async () => {
    const llm: LLMClient = {
      isConfigured: true,
      model: "test",
      generate: vi.fn().mockResolvedValueOnce({
        text: "// thinking out loud\nThe actual answer.",
        tokensIn: 0,
        tokensOut: 0,
      }),
    };
    const out = await synthesize([chunkedShard("a")], "q", llm, { outputFormat: "markdown" });
    expect(out).not.toContain("//");
    expect(out).toBe("The actual answer.");
  });
});

describe("synthesize: heuristic output formats", () => {
  it("markdown includes a # Findings header and per-source sections", async () => {
    const out = await synthesize(
      [chunkedShard("a", "github"), chunkedShard("b", "reddit")],
      "q",
      null,
      { outputFormat: "markdown" },
    );
    expect(out).toContain("# Findings: q");
    expect(out).toContain("## [github] a");
    expect(out).toContain("## [reddit] b");
  });

  it("json returns a parseable object with answer, key_points, sources", async () => {
    const out = await synthesize(
      [chunkedShard("a", "github")],
      "q",
      null,
      { outputFormat: "json" },
    );
    const obj = JSON.parse(out);
    expect(obj.answer).toContain("github");
    expect(Array.isArray(obj.key_points)).toBe(true);
    expect(obj.key_points[0]).toContain("summary a");
    expect(Array.isArray(obj.sources)).toBe(true);
    expect(obj.sources[0]).toMatchObject({ shard_id: "a", claim: expect.any(String) });
  });

  it("summary returns 2-3 sentences (a tight paragraph)", async () => {
    const out = await synthesize(
      [chunkedShard("a"), chunkedShard("b"), chunkedShard("c")],
      "q",
      null,
      { outputFormat: "summary" },
    );
    expect(out.length).toBeLessThan(400);
    expect(out.length).toBeGreaterThan(0);
  });
});
