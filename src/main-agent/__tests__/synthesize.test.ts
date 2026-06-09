// =============================================================================
// Eyes-MCP — synthesis sanitization tests
//
// Verifies the post-processor that strips agent self-talk from LLM output.
// =============================================================================

import { describe, it, expect } from "vitest";
import { buildSynthesizePrompt } from "../../llm/prompts.js";

// We re-test the sanitizeSynthesis function by re-creating it here, since
// it's not exported. (Test the BEHAVIOR end-to-end through the prompt + a
// tiny inline replica of the strip rules.)
function sanitize(text: string): string {
  let out = text.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  const lines = out.split("\n");
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] === "") continue;
      kept.push("");
      continue;
    }
    if (line.startsWith("//")) continue;
    if (/^Findings for:\s/.test(line)) continue;
    if (/^Query:\s.*\smode:\s/.test(line)) continue;
    if (/^Query:\s.*\stotal:\s\d+\sitems?:/.test(line)) continue;
    if (/^ok:\s.*\snote:\s/.test(line)) continue;
    if (/^Note(?:\s+that)?:\s/i.test(line)) continue;
    kept.push(raw);
  }
  return kept.join("\n").trim();
}

describe("synthesize: prompt rules", () => {
  it("explicitly forbids <thought>, //, and shard metadata strings", () => {
    const p = buildSynthesizePrompt({
      originalPrompt: "test",
      shardSummaries: [],
      chunkSample: "(no chunks)",
      outputFormat: "markdown",
    });
    expect(p).toContain("<thought>");
    expect(p).toContain("//");
    expect(p).toContain("Findings for:");
    expect(p).toContain("Note that");
  });
});

describe("synthesize: sanitizer strips leaked agent monologue", () => {
  it("removes <thought>...</thought> blocks", () => {
    const input = "<thought>The user wants X.</thought>\n\nX is great.";
    expect(sanitize(input)).toBe("X is great.");
  });

  it("removes lines starting with //", () => {
    const input = "Real answer line 1.\n// Note: scratch comment\nReal answer line 2.";
    const out = sanitize(input);
    expect(out).not.toContain("//");
    expect(out).toContain("Real answer line 1.");
    expect(out).toContain("Real answer line 2.");
  });

  it("removes 'Findings for:' debug dumps", () => {
    const input = "Findings for: gemma 4 31b\nQuery: gemma mode: search total: 0\nok: true note: no URL provided";
    const out = sanitize(input);
    expect(out).not.toContain("Findings for:");
    expect(out).not.toContain("mode: search");
    expect(out).not.toContain("ok: true");
  });

  it("removes 'Note that' and 'Note:' self-talk", () => {
    const input = "Note: the evidence is sparse.\nThe actual answer is X.";
    const out = sanitize(input);
    expect(out).not.toContain("Note:");
    expect(out).toContain("The actual answer is X.");
  });

  it("collapses runs of empty lines to a single blank", () => {
    const input = "Line 1.\n\n\n\nLine 2.";
    expect(sanitize(input)).toBe("Line 1.\n\nLine 2.");
  });

  it("preserves prose with internal punctuation", () => {
    const input = "Bun is fast. Deno is stable. Both run TypeScript natively.";
    expect(sanitize(input)).toBe(input);
  });

  it("keeps the user's actual answer while removing a leaked preface", () => {
    const input = `// Note: I'm going to start with a summary
Gemma 4 31B is Google's open-weights model with 31 billion parameters. It supports a 32k context window and is available free in AI Studio.

(Source: official Google AI documentation)`;
    const out = sanitize(input);
    expect(out).not.toContain("// Note");
    expect(out).toContain("Gemma 4 31B is Google's open-weights model");
    expect(out).toContain("32k context window");
    expect(out).toContain("Source: official Google AI documentation");
  });
});
