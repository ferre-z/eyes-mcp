// =============================================================================
// Eyes-MCP — YouTube adapter
//
// URL mode (preferred): extract the video id from a youtube.com / youtu.be
// URL, then fetch:
//   * Metadata via the public oEmbed endpoint (no API key needed).
//   * Captions via the timedtext endpoint (XML; we parse with a tiny regex).
//
// Query mode: oEmbed is a URL-only API, so for a bare search term we cannot
// resolve to a video without an authenticated search call. We write an empty
// payload with a `note` so the parse layer can mark the shard as a no-op.
//
// Rate limit: none enforced locally. oEmbed is unrestricted; timedtext is
// rate-limited per IP but we only request one transcript per shard.
// =============================================================================

import { writeFile } from "node:fs/promises";
import {
  AdapterError,
  httpFetch,
  httpFetchJson,
  shardIdFromOutPath,
} from "./http.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
// Matches both `youtube.com/watch?v=ID` and `youtu.be/ID`. The id is 11 chars
// from the base64url alphabet.
const YT_URL_RE =
  /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface OEmbedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  html?: string;
  provider_name?: string;
  width?: number;
  height?: number;
}

export const youtubeAdapter: ShardAdapter = {
  category: "youtube",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    const videoId = extractVideoId(query);

    if (!videoId) {
      const artifact: RawShardArtifact = {
        shardId: shardIdFromOutPath(outPath),
        source: "youtube",
        query,
        fetchedAt: new Date().toISOString(),
        payload: {
          ok: true,
          videoId: null,
          note: "no URL provided, oEmbed requires a video URL",
          metadata: null,
          transcript: null,
        },
      };
      await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
      return;
    }

    const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(fullUrl)}&format=json`;

    const metadata = await httpFetchJson<OEmbedResponse>(oembedUrl, {
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const transcript = await fetchTranscript(videoId, timeoutMs);

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "youtube",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        ok: true,
        videoId,
        url: fullUrl,
        metadata: {
          title: metadata.title ?? "",
          author_name: metadata.author_name ?? "",
          author_url: metadata.author_url ?? "",
          thumbnail_url: metadata.thumbnail_url ?? "",
        },
        transcript,
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};

function extractVideoId(input: string): string | null {
  const m = YT_URL_RE.exec(input.trim());
  return m && m[1] ? m[1] : null;
}

/**
 * Fetch the auto-generated English transcript (XML) and concatenate the
 * <text> elements. We don't try to map timings; the parse layer doesn't
 * need them. On any failure, return an empty transcript — many videos
 * have no captions at all and that's not a fatal error for the shard.
 */
async function fetchTranscript(
  videoId: string,
  timeoutMs: number,
): Promise<{ available: boolean; language: string; text: string }> {
  const url = `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}&fmt=srv3`;
  try {
    const res = await httpFetch(url, {
      // timedtext returns XML, not JSON. Tell the server we're fine with text.
      headers: { Accept: "text/plain, text/xml;q=0.9, */*;q=0.5" },
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { available: false, language: "en", text: "" };
    }
    const xml = await res.text();
    const text = extractTranscriptText(xml);
    if (text.length === 0) {
      return { available: false, language: "en", text: "" };
    }
    return { available: true, language: "en", text };
  } catch (err) {
    if (err instanceof AdapterError) {
      // Timeout / not_found is fine; treat as "no transcript".
      return { available: false, language: "en", text: "" };
    }
    return { available: false, language: "en", text: "" };
  }
}

/** Concatenate all <text>…</text> nodes from an srv3 / TTML-ish transcript. */
function extractTranscriptText(xml: string): string {
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1] ?? "";
    if (!raw) continue;
    out.push(decodeXmlEntities(raw).replace(/\s+/g, " ").trim());
  }
  return out.join(" ").trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}
