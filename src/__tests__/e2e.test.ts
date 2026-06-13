// =============================================================================
// Eyes-MCP — end-to-end transport test
//
// Spins up the real HTTP server, initializes an MCP streamable HTTP session,
// and calls the ping tool. No network; everything is localhost.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp, startServer, shutdownServer } from "../server.js";

describe("e2e: MCP streamable HTTP", () => {
  let server: Server;
  let port: number;
  let closeSessions: () => Promise<void>;
  let sessionId: string | null = null;
  const baseUrl = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    const { app, closeSessions: _close } = createApp();
    closeSessions = _close;
    server = await startServer(app, "127.0.0.1", 0);
    const address = server.address();
    if (address && typeof address === "object") {
      port = address.port;
    } else {
      throw new Error("server did not bind to an ephemeral port");
    }
  });

  afterAll(async () => {
    await closeSessions();
    await shutdownServer(server);
  });

  it("POST /health returns ok", async () => {
    const res = await fetch(`${baseUrl()}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("POST /mcp initializes a session and returns Mcp-Session-Id", async () => {
    const res = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eyes-e2e", version: "0.1.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    sessionId = res.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    const body = (await res.json()) as { jsonrpc: string; id: number; result?: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
  });

  it("calls the ping tool over the initialized session", async () => {
    expect(sessionId).toBeTruthy();
    const res = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ping",
          arguments: {},
        },
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: { content: Array<{ type: string; text: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(2);
    expect(body.result?.content[0]?.text).toBe("pong");
  });

  it("rejects a stale Mcp-Session-Id with a 404", async () => {
    const res = await fetch(`${baseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "definitely-stale-session-id",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toContain("Session not found");
  });
});
