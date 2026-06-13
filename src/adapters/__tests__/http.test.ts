// =============================================================================
// Eyes-MCP — shared HTTP wrapper tests
//
// We mock global `fetch` (Node 20+ has it built-in). Cover:
//   * 2xx happy path
//   * non-2xx → AdapterError with classified kind
//   * timeout
//   * network failure
//   * body snippet cap
//   * shardIdFromOutPath
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdapterError, httpFetch, httpFetchJson, httpFetchText, shardIdFromOutPath } from "../http.js";

interface MockResponseInit {
  status?: number;
  ok?: boolean;
  body?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body ?? "";
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: "",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
    headers: new Headers(),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http: shardIdFromOutPath", () => {
  it("strips a .json extension", () => {
    expect(shardIdFromOutPath("/data/shards/abc.json")).toBe("abc");
  });
  it("strips any extension", () => {
    expect(shardIdFromOutPath("/data/shards/abc.stripped.txt")).toBe("abc.stripped");
  });
  it("returns the directory name when given a directory path", () => {
    // Documenting current behavior: the function assumes a file path with
    // an extension. A directory path yields its basename. (This isn't
    // actually called with a directory in production — the dispatcher
    // always writes to a file.)
    expect(shardIdFromOutPath("/data/shards/")).toBe("shards");
  });
});

describe("http: httpFetch happy path", () => {
  it("returns the response on a 200", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 200, body: "ok" }));
    const res = await httpFetch("https://x.test/", { timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("ok");
  });

  it("sends a User-Agent header by default", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse());
    await httpFetch("https://x.test/");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["User-Agent"]).toMatch(/eyes-mcp/);
  });
});

describe("http: httpFetch failure modes", () => {
  it("404 → AdapterError(not_found)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 404, body: "missing" }));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      name: "AdapterError",
      errorKind: "not_found",
      status: 404,
    });
  });

  it("429 → AdapterError(rate_limit)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 429, body: "slow down" }));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      errorKind: "rate_limit",
    });
  });

  it("403 → AdapterError(blocked)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 403, body: "nope" }));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      errorKind: "blocked",
    });
  });

  it("408 → AdapterError(timeout) (status-side)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 408, body: "" }));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      errorKind: "timeout",
    });
  });

  it("5xx → AdapterError(other)", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, body: "" }));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      errorKind: "other",
    });
  });

  it("caps the error body snippet at 240 chars", async () => {
    const big = "x".repeat(10_000);
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, body: big }));
    try {
      await httpFetch("https://x.test/");
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(400);
      expect((err as Error).message).toContain(big.slice(0, 100));
    }
  });

  it("translates AbortError on a real timeout into AdapterError(timeout)", async () => {
    // Simulate what fetch actually does when its AbortSignal fires: reject
    // with an AbortError. The http wrapper checks controller.signal.aborted
    // (the controller the wrapper itself owns) to decide timeout vs. other.
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      // Wait until the abort fires, then throw.
      return await new Promise<Response>((_, reject) => {
        const sig = (init as { signal: AbortSignal }).signal;
        if (sig.aborted) {
          reject(abortError);
          return;
        }
        sig.addEventListener("abort", () => reject(abortError), { once: true });
      });
    });
    await expect(httpFetch("https://x.test/", { timeoutMs: 30 })).rejects.toMatchObject({
      errorKind: "timeout",
    });
  });

  it("translates a network error into AdapterError(other) with the message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("connect ECONNREFUSED"));
    await expect(httpFetch("https://x.test/")).rejects.toMatchObject({
      errorKind: "other",
    });
  });
});

describe("http: httpFetchJson", () => {
  it("parses JSON on 200", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: '{"x":1}' }));
    const r = await httpFetchJson<{ x: number }>("https://x.test/");
    expect(r.x).toBe(1);
  });

  it("throws AdapterError(parse) on bad JSON", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: "not json{" }));
    await expect(httpFetchJson("https://x.test/")).rejects.toMatchObject({
      errorKind: "parse",
    });
  });
});

describe("http: httpFetchText", () => {
  it("returns the raw text", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: "hello" }));
    const t = await httpFetchText("https://x.test/");
    expect(t).toBe("hello");
  });
});

describe("AdapterError", () => {
  it("preserves cause when given", () => {
    const cause = new Error("orig");
    const e = new AdapterError("wrap", "other", { cause });
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("AdapterError");
  });
});
