// =============================================================================
// Eyes-MCP — entry point
//
// Owns: HTTP server, /health, /mcp, signal handling, graceful shutdown.
// Does NOT own: tool implementations, agent logic, source adapters, parsing.
// Those are owned by subagents B and C and wired in via ./tools/index.js.
//
// Transport: streamable HTTP, stateful sessions, multi-tenant.
// =============================================================================

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { logger, createRequestLogger } from "./util/logger.js";
import { handleHealth } from "./health.js";
// TODO(subagent-B): replace stub with real tool registration.
import { registerTools } from "./tools/index.js";

const HOST = process.env["EYES_HTTP_HOST"] ?? "0.0.0.0";
const PORT = Number.parseInt(process.env["EYES_HTTP_PORT"] ?? "8787", 10);

// ---------------------------------------------------------------------------
// Per-request MCP server factory. We build a new McpServer + transport for
// every HTTP request so sessions stay isolated (multi-tenant, stateful).
// ---------------------------------------------------------------------------
function buildSession(req: Request, res: Response): { server: McpServer; transport: StreamableHTTPServerTransport } {
  const reqLog = createRequestLogger(randomUUID());

  const server = new McpServer(
    { name: "eyes-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // TODO(subagent-B): tools get registered here.
  registerTools(server, { logger: reqLog });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // We handle request bodies ourselves via express.json() below.
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      reqLog.info("mcp session initialized", { sessionId });
    },
    onsessionclosed: (sessionId) => {
      reqLog.info("mcp session closed", { sessionId });
    },
  });
  // Fires when the transport itself closes (e.g. HTTP connection dropped).
  transport.onclose = () => reqLog.debug("mcp transport closed");

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

// MCP streamable HTTP endpoint. The SDK handles both POST (call) and
// GET/DELETE (notifications/terminate) on the same path.
const MCP_PATH = "/mcp";
app.all(MCP_PATH, async (req: Request, res: Response) => {
  const { server, transport } = buildSession(req, res);
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error("mcp request failed", {
      err: err instanceof Error ? err.message : String(err),
      method: req.method,
    });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  } finally {
    // session cleanup is handled by transport.onclose above.
    void server.close().catch(() => undefined);
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
  logger.info("eyes-mcp listening", { host: HOST, port: PORT, mcpPath: MCP_PATH });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — give in-flight MCP requests up to 10s to drain.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown initiated", { signal });
  // Stop accepting new connections.
  httpServer.close((err) => {
    if (err) logger.error("http close error", { err: err.message });
    logger.info("shutdown complete");
    process.exit(err ? 1 : 0);
  });
  // Hard exit if drain takes too long.
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
