// =============================================================================
// Eyes-MCP — entry point
//
// Owns: HTTP server, /health, /mcp, signal handling, graceful shutdown.
// Does NOT own: tool implementations, agent logic, source adapters, parsing.
// Those are wired in via ./tools/index.js.
//
// Transport: streamable HTTP, stateful sessions, multi-tenant.
//
// Multi-tenant = one (McpServer, StreamableHTTPServerTransport) pair PER
// SESSION, keyed by Mcp-Session-Id header. The transport is the unit of
// session state; reusing it across sessions is the single-tenant pattern,
// which breaks when multiple agents connect.
// =============================================================================

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { logger, createRequestLogger } from "./util/logger.js";
import { handleHealth } from "./health.js";
import { registerTools } from "./tools/index.js";

const HOST = process.env["EYES_HTTP_HOST"] ?? "0.0.0.0";
const PORT = Number.parseInt(process.env["EYES_HTTP_PORT"] ?? "8787", 10);

// ---------------------------------------------------------------------------
// Session registry: Mcp-Session-Id -> { server, transport }
// ---------------------------------------------------------------------------
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}
const sessions = new Map<string, Session>();

function buildSession(sessionId: string): Session {
  const reqLog = createRequestLogger(sessionId);

  const server = new McpServer(
    { name: "eyes-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { logger: reqLog });

  const transport = new StreamableHTTPServerTransport({
    // Use a fixed session id so the SDK recognizes returning requests for
    // this session. We generate the id on the FIRST request (the one
    // without the header) and propagate it.
    sessionIdGenerator: () => sessionId,
    enableJsonResponse: true,
    onsessioninitialized: () => {
      reqLog.info("mcp session initialized");
    },
    onsessionclosed: () => {
      reqLog.info("mcp session closed");
      sessions.delete(sessionId);
    },
  });
  transport.onclose = () => {
    reqLog.info("mcp transport closed");
    sessions.delete(sessionId);
  };
  transport.onerror = (err) => reqLog.error("mcp transport error", { err: String(err) });

  return { server, transport };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));
app.use(express.json({ limit: "4mb" }));

// Per-request access log + request id
app.use((req: Request, res: Response, next: NextFunction) => {
  const rid = (req.headers["x-request-id"] as string) ?? randomUUID();
  res.setHeader("X-Request-Id", rid);
  (req as Request & { requestId: string }).requestId = rid;
  const start = Date.now();
  res.on("finish", () => {
    logger.http("request", {
      requestId: rid,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
});

app.get("/health", (req, res) => {
  void handleHealth(req, res);
});

// MCP streamable HTTP endpoint — POST (call) + GET/DELETE (notifications).
app.all("/mcp", async (req: Request, res: Response) => {
  // Pull or mint a session id. For new sessions (the `initialize` call
  // carries no Mcp-Session-Id header), the transport will assign one
  // using sessionIdGenerator — which we wired to return OUR id.
  const incoming = (req.headers["mcp-session-id"] as string | undefined) ?? "";
  const sessionId = incoming.length > 0 ? incoming : randomUUID();

  let session = sessions.get(sessionId);
  if (!session) {
    session = buildSession(sessionId);
    sessions.set(sessionId, session);
    // CRITICAL: connect the transport to the server BEFORE handling
    // requests. Without this, the transport has no dispatcher and never
    // writes a JSON-RPC reply to the client (the original bug).
    await session.server.connect(session.transport);
  }

  try {
    await session.transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("mcp request failed", {
      err: err instanceof Error ? err.message : String(err),
      method: req.method,
    });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
});

// 404 + error handlers
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "not found", path: req.path });
});
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("unhandled error", { err: err instanceof Error ? err.message : String(err) });
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const httpServer = app.listen(PORT, HOST, () => {
  logger.info("eyes-mcp listening", { host: HOST, port: PORT, mcpPath: "/mcp" });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — close all sessions, drain HTTP, then exit.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown initiated", { signal });
  for (const [id, s] of sessions) {
    try {
      await s.transport.close();
      await s.server.close();
    } catch (err) {
      logger.error("session close error", { id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  sessions.clear();
  httpServer.close((err) => {
    if (err) logger.error("http close error", { err: err.message });
    logger.info("shutdown complete");
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => {
    logger.warn("forced exit after 10s drain timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err: err.message, stack: err.stack });
});
