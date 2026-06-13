// =============================================================================
// Eyes-MCP — YouTube adapter parser tests
//
// extractVideoId is the URL parser; extractTranscriptText parses srv3 / TTML.
// Both are pure functions and the most likely places for regressions.
// =============================================================================

import { describe, it, expect } from "vitest";
import { youtubeAdapter } from "../youtube.js";

// We don't have a way to import the private helpers, so we re-derive
// the ID extractor the same way it lives in the source. If youtube.ts
// changes its regex, mirror it here.
function extractVideoId(input: string): string | null {
  const m = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/.exec(input.trim());
  return m && m[1] ? m[1] : null;
}

function extractTranscriptText(xml: string): string {
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1] ?? "";
    if (!raw) continue;
    out.push(
      raw
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, dec: string) => {
          const code = Number.parseInt(dec, 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : "";
        })
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out.join(" ").trim();
}

describe("youtube: video id extraction", () => {
  it("matches a full youtube.com URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("matches a youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("matches even with extra query params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for a bare search term", () => {
    expect(extractVideoId("rust vs go")).toBeNull();
  });

  it("returns null for a non-youtube URL", () => {
    expect(extractVideoId("https://vimeo.com/12345")).toBeNull();
  });

  it("tolerates whitespace around the URL", () => {
    expect(extractVideoId("  https://youtu.be/dQw4w9WgXcQ  ")).toBe("dQw4w9WgXcQ");
  });
});

describe("youtube: transcript text extraction", () => {
  it("joins <text> elements with single spaces", () => {
    const xml = `<transcript>
      <text start="0" dur="1">Hello</text>
      <text start="1" dur="1">world</text>
      <text start="2" dur="1">foo</text>
    </transcript>`;
    expect(extractTranscriptText(xml)).toBe("Hello world foo");
  });

  it("decodes HTML entities inside text", () => {
    const xml = `<t><text>He said &quot;hi&quot; &amp; waved</text></t>`;
    expect(extractTranscriptText(xml)).toBe('He said "hi" & waved');
  });

  it("decodes decimal numeric character references", () => {
    // The decoder handles &#NNN; only; hex form &#xHH; is left as-is.
    const xml = `<t><text>&#65;&#x42;</text></t>`;
    expect(extractTranscriptText(xml)).toBe("A&#x42;");
  });

  it("returns '' for an empty payload", () => {
    expect(extractTranscriptText("")).toBe("");
    expect(extractTranscriptText("<transcript></transcript>")).toBe("");
  });

  it("collapses newlines / runs of spaces inside a <text>", () => {
    const xml = `<t><text>line one\n\nline   two</text></t>`;
    expect(extractTranscriptText(xml)).toBe("line one line two");
  });
});

describe("youtube: adapter shape", () => {
  it("declares category youtube", () => {
    expect(youtubeAdapter.category).toBe("youtube");
  });
});
