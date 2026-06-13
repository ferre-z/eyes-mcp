// =============================================================================
// Eyes-MCP — HTTP server factory
//
// Separated from src/index.ts so tests can build an app/start a server without
// importing the boot side effects (signal handlers, process.exit, dotenv).
//
// Exports:
//   * createApp()     – builds the express app with /health and /mcp routes.
//   * startServer()   – listens on a host/port and returns the http.Server.
//   * shutdownServer() – graceful close of sessions + http server.
// =============================================================================

import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { logger, createRequestLogger } from "./util/logger.js";
import { handleHealth } from "./health.js";
import { registerTools } from "./tools/index.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function buildSession(sessions: Map<string, Session>, sessionId: string): Session {
  const reqLog = createRequestLogger(sessionId);

  const server = new McpServer(
    { name: "eyes-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { logger: reqLog });

  const transport = new StreamableHTTPServerTransport({
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

export interface AppBundle {
  app: express.Express;
  /** Close all MCP sessions owned by this app. */
  closeSessions(): Promise<void>;
}

export function createApp(): AppBundle {
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

  const sessions = new Map<string, Session>();

  // MCP streamable HTTP endpoint — POST (call) + GET/DELETE (notifications).
  // Note: per-session rate limiting is intentionally deferred to v0.2. The
  // current multi-tenant design keeps a session map, which is the right place
  // to attach a token-bucket limiter later without changing the transport.
  app.all("/mcp", async (req: Request, res: Response) => {
    const incoming = (req.headers["mcp-session-id"] as string | undefined) ?? "";

    // If the client thinks it has a session but we don't know it, fail
    // loudly. Silently minting a new session hides server restarts and
    // breaks the MCP "stateful session" contract.
    if (incoming.length > 0 && !sessions.has(incoming)) {
      logger.warn("mcp session id not found", { sessionId: incoming });
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Session not found" },
        id: null,
      });
      return;
    }

    const sessionId = incoming.length > 0 ? incoming : randomUUID();

    let session = sessions.get(sessionId);
    if (!session) {
      session = buildSession(sessions, sessionId);
      sessions.set(sessionId, session);
      // CRITICAL: connect the transport to the server BEFORE handling
      // requests. Without this, the transport has no dispatcher and never
      // writes a JSON-RPC reply to the client.
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
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("unhandled error", { err: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  async function closeSessions(): Promise<void> {
    for (const [id, s] of sessions) {
      try {
        await s.transport.close();
        await s.server.close();
      } catch (err) {
        logger.error("session close error", { id, err: err instanceof Error ? err.message : String(err) });
      }
    }
    sessions.clear();
  }

  return { app, closeSessions };
}

export function startServer(
  app: express.Express,
  host = process.env["EYES_HTTP_HOST"] ?? "0.0.0.0",
  port = Number.parseInt(process.env["EYES_HTTP_PORT"] ?? "8787", 10),
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      logger.info("eyes-mcp listening", { host, port, mcpPath: "/mcp" });
      resolve(server);
    });
    server.on("error", reject);
  });
}

export async function shutdownServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
