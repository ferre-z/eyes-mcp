// =============================================================================
// Eyes-MCP — per-adapter summarizer tests
//
// Each summarizer takes a raw artifact body and emits a markdown-ish
// string with real paragraph structure. These tests cover one shape per
// adapter, the registry lookup, and the unknown-source fallback.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  summarizeArtifact,
  getSummarizer,
} from "../summarize.js";

describe("summarizer: registry", () => {
  it("returns a summarizer for every known source id", () => {
    for (const id of [
      "searxng",
      "github",
      "reddit",
      "hackernews",
      "arxiv",
      "wikipedia",
      "youtube",
      "crawl4ai",
      "generic",
      "osm",
    ]) {
      expect(typeof getSummarizer(id)).toBe("function");
    }
  });

  it("returns a generic fallback for an unknown source", () => {
    const fn = getSummarizer("nope-not-a-source");
    expect(typeof fn).toBe("function");
  });
});

describe("summarizer: summarizeArtifact", () => {
  it("falls back gracefully on non-JSON input", () => {
    const out = summarizeArtifact("not json at all");
    expect(out).toBe("not json at all");
  });

  it("falls back gracefully on a missing source field", () => {
    const out = summarizeArtifact(JSON.stringify({ payload: { x: 1 } }));
    expect(out).toContain("x");
  });
});

describe("summarizer: searxng", () => {
  const raw = JSON.stringify({
    shardId: "s1",
    source: "searxng",
    query: "rust",
    fetchedAt: "2024-01-01",
    payload: {
      results: [
        { title: "Rust homepage", url: "https://rust-lang.org", snippet: "A language empowering everyone" },
        { title: "Rust book", url: "https://doc.rust-lang.org/book", snippet: "The Rust Programming Language" },
      ],
    },
  });

  it("emits a bullet list with titles, urls, and snippets", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Rust homepage");
    expect(out).toContain("https://rust-lang.org");
    expect(out).toContain("A language empowering everyone");
    expect(out).toContain("Rust book");
  });

  it("puts each result on its own paragraph (blank-line separated)", () => {
    const out = summarizeArtifact(raw);
    const paragraphs = out.split("\n\n");
    expect(paragraphs.length).toBe(2);
  });

  it("emits a placeholder for an empty results array", () => {
    const empty = JSON.stringify({ source: "searxng", payload: { results: [] } });
    expect(summarizeArtifact(empty)).toBe("(no results)");
  });

  it("strips HTML from snippets", () => {
    const withHtml = JSON.stringify({
      source: "searxng",
      payload: { results: [{ title: "T", url: "https://x", snippet: "<em>highlighted</em> text" }] },
    });
    const out = summarizeArtifact(withHtml);
    expect(out).not.toContain("<em>");
    expect(out).toContain("highlighted text");
  });
});

describe("summarizer: github (search mode)", () => {
  const raw = JSON.stringify({
    source: "github",
    payload: {
      mode: "search",
      total: 2,
      items: [
        { full_name: "rust-lang/rust", description: "Empowering everyone", stargazers_count: 80000, language: "Rust", html_url: "https://github.com/rust-lang/rust" },
        { full_name: "tokio-rs/tokio", description: "Async runtime", stargazers_count: 25000, language: "Rust", html_url: "https://github.com/tokio-rs/tokio" },
      ],
    },
  });

  it("emits a header with the total count", () => {
    expect(summarizeArtifact(raw)).toMatch(/Found 2 repositories/);
  });

  it("includes each repo's name, stars, language, and description", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("rust-lang/rust");
    expect(out).toContain("80000 stars");
    expect(out).toContain("Rust");
    expect(out).toContain("Empowering everyone");
    expect(out).toContain("tokio-rs/tokio");
  });
});

describe("summarizer: github (repo mode)", () => {
  const raw = JSON.stringify({
    source: "github",
    payload: {
      mode: "repo",
      full_name: "rust-lang/rust",
      description: "Empowering everyone to build reliable and efficient software.",
      html_url: "https://github.com/rust-lang/rust",
      stargazers_count: 80000,
      language: "Rust",
      updated_at: "2024-01-15",
      topics: ["rust", "compiler", "language"],
      readme_text: "# Rust\nA language.",
    },
  });

  it("emits a heading with the repo name", () => {
    expect(summarizeArtifact(raw)).toMatch(/^# rust-lang\/rust/);
  });

  it("includes the description, stats, and topics", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Empowering everyone");
    expect(out).toContain("80000 stars");
    expect(out).toContain("rust, compiler, language");
  });

  it("includes the README under a '## README' heading", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("## README");
    expect(out).toContain("# Rust");
    expect(out).toContain("A language.");
  });

  it("caps the README at 8000 chars", () => {
    const huge = JSON.stringify({
      source: "github",
      payload: {
        mode: "repo",
        full_name: "x/y",
        description: "d",
        stargazers_count: 0,
        language: "L",
        updated_at: "2024-01-01",
        topics: [],
        readme_text: "A".repeat(50_000),
      },
    });
    const out = summarizeArtifact(huge);
    const readmeStart = out.indexOf("## README");
    const after = out.slice(readmeStart);
    // The 8000 cap is on the field; the rest of the document adds overhead,
    // but the A's should stop well before 50_000.
    const aCount = (after.match(/A/g) ?? []).length;
    expect(aCount).toBeLessThan(10_000);
  });
});

describe("summarizer: reddit", () => {
  const raw = JSON.stringify({
    source: "reddit",
    payload: {
      subreddit: "rust",
      total: 1,
      posts: [
        {
          title: "What's new in Rust 1.80?",
          url: "https://example.com/post",
          subreddit: "rust",
          author: "alice",
          score: 123,
          num_comments: 45,
          selftext: "A discussion about the new release.",
          top_comments: [
            { body: "Great summary", author: "bob", score: 10 },
            { body: "Thanks for sharing", author: "carol", score: 5 },
          ],
        },
      ],
    },
  });

  it("includes the post title, score, and comment count", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("What's new in Rust 1.80?");
    expect(out).toContain("r/rust");
    expect(out).toContain("123↑");
    expect(out).toContain("45 comments");
  });

  it("includes top comments as blockquotes", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Great summary");
    expect(out).toContain("> ");
  });
});

describe("summarizer: hackernews", () => {
  const raw = JSON.stringify({
    source: "hackernews",
    payload: {
      total: 2,
      items: [
        { title: "Show HN: A new editor", url: "https://example.com", points: 500, numComments: 120, author: "show_hn_user" },
        { title: "Why Rust is eating systems", url: "https://example.com/rust", points: 300, numComments: 80, author: "rsc" },
      ],
    },
  });

  it("emits a header with the total", () => {
    expect(summarizeArtifact(raw)).toMatch(/Found 2 stories/);
  });

  it("includes each story's title, points, comments, and author", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Show HN: A new editor");
    expect(out).toContain("500↑");
    expect(out).toContain("120 comments");
    expect(out).toContain("by show_hn_user");
  });
});

describe("summarizer: arxiv", () => {
  const raw = JSON.stringify({
    source: "arxiv",
    payload: {
      total: 1,
      items: [
        {
          id: "2401.01234",
          title: "Attention Is All You Need (Revisited)",
          summary: "We re-examine the transformer architecture.",
          authors: ["Alice", "Bob", "Carol", "Dan"],
          published: "2024-01-02T00:00:00Z",
          link: "https://arxiv.org/abs/2401.01234",
        },
      ],
    },
  });

  it("emits a ## heading per paper", () => {
    const out = summarizeArtifact(raw);
    expect(out).toMatch(/## Attention Is All You Need/);
  });

  it("includes authors with a +N truncation when there are many", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Alice, Bob");
    expect(out).toContain("+ 2 more");
  });

  it("includes the arXiv link", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("https://arxiv.org/abs/2401.01234");
  });
});

describe("summarizer: wikipedia", () => {
  const raw = JSON.stringify({
    source: "wikipedia",
    payload: {
      total: 1,
      hits: [{ title: "Rust (programming language)", snippet: "Systems language" }],
      summaries: [
        {
          title: "Rust (programming language)",
          description: "Multi-paradigm programming language",
          extract: "Rust is a multi-paradigm, high-level, general-purpose programming language.",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Rust" } },
        },
      ],
    },
  });

  it("emits a ## heading per hit", () => {
    const out = summarizeArtifact(raw);
    expect(out).toMatch(/## Rust \(programming language\)/);
  });

  it("includes the description and extract", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Multi-paradigm programming language");
    expect(out).toContain("high-level, general-purpose");
  });

  it("includes a 'Read more' link when content_urls is present", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("[Read more](https://en.wikipedia.org/wiki/Rust)");
  });
});

describe("summarizer: youtube", () => {
  it("emits a heading with title and author when metadata is present", () => {
    const raw = JSON.stringify({
      source: "youtube",
      payload: {
        ok: true,
        videoId: "abc12345678",
        url: "https://www.youtube.com/watch?v=abc12345678",
        metadata: { title: "A great talk", author_name: "Speaker" },
        transcript: { available: true, language: "en", text: "Hello world from the transcript" },
      },
    });
    const out = summarizeArtifact(raw);
    expect(out).toContain("# A great talk");
    expect(out).toContain("by Speaker");
    expect(out).toContain("## Transcript");
    expect(out).toContain("Hello world from the transcript");
  });

  it("says (no transcript available) when transcript is unavailable", () => {
    const raw = JSON.stringify({
      source: "youtube",
      payload: {
        ok: true,
        metadata: { title: "X", author_name: "Y" },
        transcript: { available: false, language: "en", text: "" },
      },
    });
    const out = summarizeArtifact(raw);
    expect(out).toContain("(no transcript available)");
    expect(out).not.toContain("## Transcript");
  });

  it("emits a placeholder when no metadata is present (bare query, not a URL)", () => {
    const raw = JSON.stringify({
      source: "youtube",
      payload: { ok: true, videoId: null, note: "no URL provided" },
    });
    const out = summarizeArtifact(raw);
    expect(out).toContain("no video metadata");
  });
});

describe("summarizer: crawl4ai / generic (markdown pass-through)", () => {
  it("returns the markdown as-is when present", () => {
    const raw = JSON.stringify({
      source: "crawl4ai",
      payload: { url: "https://x", markdown: "# Hello\n\nWorld", bytes: 12 },
    });
    const out = summarizeArtifact(raw);
    expect(out).toBe("# Hello\n\nWorld");
  });

  it("emits a placeholder when the markdown is empty", () => {
    const raw = JSON.stringify({
      source: "crawl4ai",
      payload: { url: "https://x", markdown: "", bytes: 0 },
    });
    const out = summarizeArtifact(raw);
    expect(out).toBe("(empty markdown)");
  });

  it("generic source uses the same summarizer", () => {
    const raw = JSON.stringify({
      source: "generic",
      payload: { url: "https://x", markdown: "## Section\n\nSome text" },
    });
    expect(summarizeArtifact(raw)).toBe("## Section\n\nSome text");
  });
});

describe("summarizer: osm", () => {
  const raw = JSON.stringify({
    source: "osm",
    payload: {
      total: 2,
      results: [
        { place_id: 1, lat: "48.8566", lon: "2.3522", display_name: "Paris, France", type: "city", class: "place", importance: 0.9 },
        { place_id: 2, lat: "51.5074", lon: "-0.1278", display_name: "London, UK", type: "city", class: "place", importance: 0.85 },
      ],
    },
  });

  it("emits a bullet per place with lat/lon", () => {
    const out = summarizeArtifact(raw);
    expect(out).toContain("Paris, France");
    expect(out).toContain("48.8566");
    expect(out).toContain("2.3522");
    expect(out).toContain("London, UK");
  });
});
