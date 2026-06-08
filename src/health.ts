// =============================================================================
// Eyes-MCP — health check endpoint
// Returns 200 always (so Docker's HEALTHCHECK can probe it), but reports
// per-dependency status so a human/operator can see what's degraded.
// =============================================================================

import { request } from "undici";
import type { Request, Response } from "express";
import { logger } from "./util/logger.js";

const VERSION = "0.1.0";
const START_TIME = Date.now();

interface DependencyStatus {
  url: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

async function probe(url: string, timeoutMs = 2000): Promise<DependencyStatus> {
  const t0 = Date.now();
  try {
    const res = await request(url, { method: "GET", headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    // Drain body so the socket is released.
    await res.body.dump();
    const ok = res.statusCode >= 200 && res.statusCode < 500;
    return { url, ok, latencyMs: Date.now() - t0, error: ok ? null : `status ${res.statusCode}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, ok: false, latencyMs: Date.now() - t0, error: message };
  }
}

export async function handleHealth(_req: Request, res: Response): Promise<void> {
  const searxngUrl = process.env["SEARXNG_URL"] ?? "http://searxng:8080";
  const crawl4aiUrl = process.env["CRAWL4AI_URL"] ?? "http://crawl4ai:11235";

  // Probe in parallel; never block the health response.
  const [searxng, crawl4ai] = await Promise.all([
    probe(`${searxngUrl}/healthz`),
    probe(`${crawl4aiUrl}/health`),
  ]);

  const body = {
    status: "ok",
    version: VERSION,
    uptime: Math.round((Date.now() - START_TIME) / 1000),
    dependencies: { searxng, crawl4ai },
  };

  if (!searxng.ok || !crawl4ai.ok) {
    logger.warn("health: degraded dependencies", { searxng: searxng.ok, crawl4ai: crawl4ai.ok });
  }

  res.status(200).json(body);
}
