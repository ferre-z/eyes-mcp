// =============================================================================
// Eyes-MCP — arXiv adapter
//
// arXiv's public API: http://export.arxiv.org/api/query?search_query=...
// Returns Atom XML. We parse just what we need with regex/string scanning —
// no XML library, no extra dep.
//
// Per arXiv's polite-use guidelines we identify ourselves in User-Agent.
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchText, shardIdFromOutPath } from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 25;

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  link: string;
}

export const arxivAdapter: ShardAdapter = {
  category: "arxiv",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const max = clampMax(
      Number.parseInt(process.env["ARXIV_MAX_RESULTS"] ?? "", 10) || DEFAULT_MAX_RESULTS,
    );
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;

    const xml = await httpFetchText(url, {
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      userAgent: "eyes-mcp/0.1 (mailto:hello@eyes-mcp.local)",
    });

    const entries = parseAtomEntries(xml);

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "arxiv",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        total: entries.length,
        items: entries,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

function clampMax(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

/** Parse `<entry>...</entry>` blocks from arXiv's Atom response. */
export function parseAtomEntries(xml: string): ArxivEntry[] {
  const out: ArxivEntry[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1];
    if (!body) continue;
    const id = firstMatch(body, /<id>([\s\S]*?)<\/id>/) ?? "";
    const title = cleanText(firstMatch(body, /<title>([\s\S]*?)<\/title>/) ?? "");
    const summary = cleanText(firstMatch(body, /<summary>([\s\S]*?)<\/summary>/) ?? "");
    const published = firstMatch(body, /<published>([\s\S]*?)<\/published>/) ?? "";
    // Author name(s) — pick the first name per author block.
    const authorRe = /<author>\s*<name>([\s\S]*?)<\/name>/g;
    const authors: string[] = [];
    let am: RegExpExecArray | null;
    while ((am = authorRe.exec(body)) !== null) {
      const name = cleanText(am[1] ?? "");
      if (name) authors.push(name);
    }
    // Prefer the abs link (arxiv.org/abs/...) over the pdf link.
    const link = firstMatch(body, /<link[^>]*href="(https?:\/\/arxiv\.org\/abs\/[^"]+)"/) ?? id;
    out.push({ id, title, summary, authors, published, link });
  }
  return out;
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m && m[1] ? m[1] : null;
}

/** Collapse whitespace and decode the few common XML entities. */
function cleanText(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
