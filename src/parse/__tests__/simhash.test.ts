// =============================================================================
// Eyes-MCP — simhash unit tests
// =============================================================================

import { describe, it, expect } from "vitest";
import { hamming, hash64, simhash, tokenize } from "../simhash.js";

describe("tokenize", () => {
  it("lowercases and dedupes short tokens", () => {
    const tokens = tokenize("Hello World hello WORLD");
    expect(tokens).toEqual(["hello", "world"]);
  });

  it("drops tokens shorter than 2 characters", () => {
    const tokens = tokenize("a an the cat dog a I");
    // 'a' and 'I' are 1 char — should be dropped
    expect(tokens).toEqual(["an", "the", "cat", "dog"]);
  });

  it("returns [] for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("hash64", () => {
  it("returns a bigint", () => {
    const h = hash64("hello");
    expect(typeof h).toBe("bigint");
    expect(h).toBeGreaterThanOrEqual(0n);
  });

  it("is deterministic for the same token", () => {
    expect(hash64("hello")).toBe(hash64("hello"));
  });

  it("produces different values for different tokens", () => {
    expect(hash64("hello")).not.toBe(hash64("world"));
  });
});

describe("simhash", () => {
  it("returns 0n for an empty token list", () => {
    expect(simhash([])).toBe(0n);
  });

  it("returns a non-zero bigint for a non-empty token list", () => {
    const h = simhash(["hello", "world"]);
    expect(h).not.toBe(0n);
    expect(typeof h).toBe("bigint");
  });
});

describe("hamming", () => {
  it("is 0 for identical simhashes", () => {
    const a = simhash(["hello", "world", "this", "is", "a", "test"]);
    const b = simhash(["hello", "world", "this", "is", "a", "test"]);
    expect(hamming(a, b)).toBe(0);
  });

  it("two near-identical texts have hamming distance < 5", () => {
    // Simhash is a high-recall, low-precision near-duplicate detector:
    // changing one word in a long text should still produce a very small
    // hamming distance. We use 100 tokens with a single change to get
    // a stable result under the < 5 dedup threshold.
    const baseText = Array.from({ length: 100 }, (_, i) => `token${i}`).join(" ");
    const modifiedText = baseText.replace("token50", "REPLACED");
    const tokensA = tokenize(baseText);
    const tokensB = tokenize(modifiedText);
    const d = hamming(simhash(tokensA), simhash(tokensB));
    expect(d).toBeLessThan(5);
  });

  it("two unrelated texts have hamming distance > 20", () => {
    const programming = tokenize(
      "javascript typescript python rust go java c++ programmer developer engineer software code function class module import export async await promise callback",
    );
    const cooking = tokenize(
      "recipe salt pepper onion garlic tomato basil oregano olive oil pan skillet bake roast simmer boil saute heat serve dish plate spoon fork knife",
    );
    const d = hamming(simhash(programming), simhash(cooking));
    expect(d).toBeGreaterThan(20);
  });
});
