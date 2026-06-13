// =============================================================================
// Eyes-MCP — health endpoint tests
//
// /health returns 200 always, with per-dependency status. The probes are
// parallel and never block the response.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock undici BEFORE importing the module under test.
const mockRequest = vi.fn();
vi.mock("undici", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { handleHealth } from "../health.js";
import type { Request, Response } from "express";

interface MockReq extends Partial<Request> {}
interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mockRequest.mockReset();
  delete process.env["SEARXNG_URL"];
  delete process.env["CRAWL4AI_URL"];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("health: handleHealth", () => {
  it("returns 200 with status=ok when dependencies are reachable", async () => {
    mockRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: () => Promise.resolve() },
    });
    const res = makeRes();
    await handleHealth({} as MockReq, res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; version: string; dependencies: { searxng: { ok: boolean }; crawl4ai: { ok: boolean } } };
    expect(body.status).toBe("ok");
    expect(body.version).toBeTruthy();
    expect(body.dependencies.searxng.ok).toBe(true);
    expect(body.dependencies.crawl4ai.ok).toBe(true);
  });

  it("still returns 200 when a dependency is unreachable (so Docker healthcheck doesn't flap)", async () => {
    // 5xx = unreachable
    mockRequest.mockResolvedValueOnce({
      statusCode: 500,
      body: { dump: () => Promise.resolve() },
    }).mockResolvedValueOnce({
      statusCode: 200,
      body: { dump: () => Promise.resolve() },
    });
    const res = makeRes();
    await handleHealth({} as MockReq, res as unknown as Response);
    expect(res.statusCode).toBe(200);
    const body = res.body as { dependencies: { searxng: { ok: boolean } } };
    expect(body.dependencies.searxng.ok).toBe(false);
  });

  it("treats a network error on the probe as not-ok", async () => {
    mockRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = makeRes();
    await handleHealth({} as MockReq, res as unknown as Response);
    expect(res.statusCode).toBe(200); // always 200
    const body = res.body as { dependencies: { searxng: { ok: boolean } } };
    expect(body.dependencies.searxng.ok).toBe(false);
  });

  it("honors SEARXNG_URL env override", async () => {
    process.env["SEARXNG_URL"] = "http://custom-host:1234";
    mockRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: () => Promise.resolve() },
    });
    const res = makeRes();
    await handleHealth({} as MockReq, res as unknown as Response);
    const body = res.body as { dependencies: { searxng: { url: string } } };
    expect(body.dependencies.searxng.url).toBe("http://custom-host:1234/healthz");
  });

  it("includes uptime and version in the body", async () => {
    mockRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: () => Promise.resolve() },
    });
    const res = makeRes();
    await handleHealth({} as MockReq, res as unknown as Response);
    const body = res.body as { version: string; uptime: number };
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
