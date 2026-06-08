// =============================================================================
// Eyes-MCP — text utilities unit tests
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  approximateTokens,
  collapseWhitespace,
  extractFirstUrl,
  looksLikeUrl,
  splitParagraphs,
  splitSentences,
  stripHtml,
} from "../text.js";

describe("stripHtml", () => {
  it("removes <b> and <a href=...> tags and entities", () => {
    const html = '<p>Hello <b>World</b> &amp; <a href="https://example.com">link</a> &lt;tag&gt;</p>';
    const out = stripHtml(html);
    expect(out).toContain("Hello");
    expect(out).toContain("World");
    expect(out).toContain("&");
    expect(out).toContain("link");
    expect(out).toContain("<tag>");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("</b>");
    expect(out).not.toContain("<a ");
  });

  it("decodes the five common entities", () => {
    const out = stripHtml("&amp; &lt; &gt; &quot; &#39;");
    expect(out).toBe("& < > \" '");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

describe("collapseWhitespace", () => {
  it("collapses multiple spaces and newlines to a single space", () => {
    const out = collapseWhitespace("hello   world\n\nfoo\t\tbar");
    expect(out).toBe("hello world foo bar");
  });

  it("trims leading and trailing whitespace", () => {
    const out = collapseWhitespace("   hello world   \n");
    expect(out).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(collapseWhitespace("")).toBe("");
  });
});

describe("splitParagraphs", () => {
  it("splits on one-or-more blank lines", () => {
    const text = "First paragraph here.\n\nSecond paragraph.\n\n\nThird.";
    const parts = splitParagraphs(text);
    expect(parts).toEqual([
      "First paragraph here.",
      "Second paragraph.",
      "Third.",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(splitParagraphs("")).toEqual([]);
  });

  it("returns a single-element array when there are no blank lines", () => {
    expect(splitParagraphs("just one paragraph")).toEqual(["just one paragraph"]);
  });
});

describe("splitSentences", () => {
  it("splits on sentence-final punctuation using lookbehind", () => {
    const text = "First sentence. Second sentence! Third? Done.";
    const parts = splitSentences(text);
    expect(parts).toEqual(["First sentence.", "Second sentence!", "Third?", "Done."]);
  });

  it("returns [] for empty input", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("keeps the trailing punctuation attached to each sentence", () => {
    const parts = splitSentences("a. b. c.");
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p.endsWith(".") || p.endsWith("!") || p.endsWith("?")).toBe(true);
    }
  });
});

describe("approximateTokens", () => {
  it("returns ceil(length/4)", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("abcd")).toBe(1);
    expect(approximateTokens("abcde")).toBe(2);
    expect(approximateTokens("a".repeat(100))).toBe(25);
  });
});

describe("looksLikeUrl", () => {
  it("returns true for http:// and https://", () => {
    expect(looksLikeUrl("http://example.com")).toBe(true);
    expect(looksLikeUrl("https://example.com/foo?bar=1")).toBe(true);
  });

  it("trims whitespace before testing", () => {
    expect(looksLikeUrl("  https://example.com  ")).toBe(true);
  });

  it("returns false for non-URL strings", () => {
    expect(looksLikeUrl("example.com")).toBe(false);
    expect(looksLikeUrl("ftp://example.com")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("extractFirstUrl", () => {
  it("returns the first http(s) URL in a string", () => {
    const text = "Check out https://example.com/foo and also http://other.org/bar for more.";
    expect(extractFirstUrl(text)).toBe("https://example.com/foo");
  });

  it("stops at common URL terminators", () => {
    const text = "see (https://example.com) for details";
    expect(extractFirstUrl(text)).toBe("https://example.com");
  });

  it("returns undefined when no URL is present", () => {
    expect(extractFirstUrl("no urls here")).toBeUndefined();
    expect(extractFirstUrl("")).toBeUndefined();
  });
});
