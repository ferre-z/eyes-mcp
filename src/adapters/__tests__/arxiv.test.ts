// =============================================================================
// Eyes-MCP — arXiv adapter parser tests
//
// parseAtomEntries is a pure function that turns arXiv's Atom XML into
// structured entries. It's the most likely thing to regress as the upstream
// feed changes shape.
// =============================================================================

import { describe, it, expect } from "vitest";
import { parseAtomEntries } from "../arxiv.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-02T00:00:00Z</published>
    <title>  Attention Is All You Need &amp; Co.  </title>
    <summary>We show that &lt;b&gt;transformers&lt;/b&gt; beat RNNs on a small benchmark.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Second</name></author>
    <link href="http://arxiv.org/abs/2401.01234v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.01234v1" rel="related" type="application/pdf"/>
    <arxiv:doi>10.1234/xyz</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.56789v2</id>
    <published>2024-02-15T00:00:00Z</published>
    <title>GPT-Style Models Survey</title>
    <summary>Another summary.</summary>
    <author><name>Carol Third</name></author>
    <link href="http://arxiv.org/abs/2402.56789v2" rel="alternate" type="text/html"/>
  </entry>
</feed>
`;

describe("arxiv: parseAtomEntries", () => {
  it("extracts one entry per <entry> block", () => {
    const out = parseAtomEntries(FEED);
    expect(out).toHaveLength(2);
  });

  it("captures id, title, summary, published, link", () => {
    const out = parseAtomEntries(FEED);
    const first = out[0]!;
    expect(first.id).toBe("http://arxiv.org/abs/2401.01234v1");
    expect(first.title).toBe("Attention Is All You Need & Co.");
    expect(first.summary).toContain("transformers");
    expect(first.summary).toContain("RNNs");
    expect(first.published).toBe("2024-01-02T00:00:00Z");
  });

  it("decodes the five common XML entities", () => {
    const out = parseAtomEntries(FEED);
    expect(out[0]!.title).toBe("Attention Is All You Need & Co.");
    expect(out[0]!.summary).not.toContain("&amp;");
    expect(out[0]!.summary).not.toContain("&lt;");
  });

  it("captures all authors in order", () => {
    const out = parseAtomEntries(FEED);
    expect(out[0]!.authors).toEqual(["Alice Example", "Bob Second"]);
    expect(out[1]!.authors).toEqual(["Carol Third"]);
  });

  it("prefers the abs/ link over the pdf link", () => {
    const out = parseAtomEntries(FEED);
    expect(out[0]!.link).toBe("http://arxiv.org/abs/2401.01234v1");
  });

  it("falls back to the id field when no abs/ link is present", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>urn:arxiv:foo</id>
    <title>No link tag</title>
    <summary>x</summary>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
</feed>`;
    const out = parseAtomEntries(xml);
    expect(out).toHaveLength(1);
    expect(out[0]!.link).toBe("urn:arxiv:foo");
  });

  it("returns [] for an empty feed", () => {
    expect(parseAtomEntries("")).toEqual([]);
    expect(parseAtomEntries("<feed></feed>")).toEqual([]);
  });

  it("skips an <entry> block with no readable id gracefully", () => {
    const xml = `<feed>
      <entry><title>no id</title><summary>x</summary><published>2024-01-01T00:00:00Z</published></entry>
    </feed>`;
    const out = parseAtomEntries(xml);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("");
    expect(out[0]!.title).toBe("no id");
  });
});
