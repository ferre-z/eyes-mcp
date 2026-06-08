// =============================================================================
// Eyes-MCP — OpenStreetMap (Nominatim) adapter
//
// Geocoder: query → top 5 places with lat/lon, display name, type, and
// a bounding box. Pure HTTP, no API key, but Nominatim's usage policy
// requires:
//   * A descriptive User-Agent (we send "eyes-mcp/0.1")
//   * Max 1 request per second (we enforce this with a token bucket)
//   * No heavy use — we cap at 5 results per query
//
// The artifact's `source` is "osm" (per the SourceId enum), but its
// `category` is "web" because the dispatcher's SourceCategory enum does
// not include an "osm" entry yet.
// =============================================================================

import { writeFile } from "node:fs/promises";
import { httpFetchJson, shardIdFromOutPath } from "./http.js";
import { createBucket } from "./rate-limit.js";
import type { RawShardArtifact, ShardAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;

// Nominatim ToS: max 1 req/sec.
const bucket = createBucket({ capacity: 1, refillPerSec: 1 });

interface NominatimPlace {
  place_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  type?: string;
  class?: string;
  importance?: number;
  boundingbox?: [string, string, string, string] | string[];
  osm_type?: string;
  osm_id?: number;
}

interface NominatimResponse extends Array<NominatimPlace> {}

export const osmAdapter: ShardAdapter = {
  category: "web",

  async search(query, _hint, _depth, outPath, timeoutMs): Promise<void> {
    await bucket.take();

    const url =
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
      `&format=json&limit=${MAX_RESULTS}&addressdetails=0`;

    const data = await httpFetchJson<NominatimResponse>(url, {
      userAgent: "eyes-mcp/0.1",
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });

    const places = (Array.isArray(data) ? data : []).slice(0, MAX_RESULTS);

    const artifact: RawShardArtifact = {
      shardId: shardIdFromOutPath(outPath),
      source: "osm",
      query,
      fetchedAt: new Date().toISOString(),
      payload: {
        total: places.length,
        results: places.map((p) => ({
          place_id: p.place_id ?? 0,
          lat: p.lat ?? "",
          lon: p.lon ?? "",
          display_name: p.display_name ?? "",
          type: p.type ?? "",
          class: p.class ?? "",
          importance: p.importance ?? 0,
          boundingbox: Array.isArray(p.boundingbox) ? p.boundingbox : [],
          osm_type: p.osm_type ?? "",
          osm_id: p.osm_id ?? 0,
        })),
      },
    };
    await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8");
  },
};
