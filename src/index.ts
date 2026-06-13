// =============================================================================
// Eyes-MCP — entry point
//
// Boots the HTTP server from src/server.ts and installs graceful shutdown
// signal handlers. All routing/session logic lives in server.ts; this file
// is intentionally small so it doesn't complicate tests.
// =============================================================================

import "dotenv/config";
import { logger } from "./util/logger.js";
import { createApp, startServer, shutdownServer } from "./server.js";

const { app, closeSessions } = createApp();

startServer(app)
  .then((server) => {
    async function shutdown(signal: string): Promise<void> {
      logger.info("shutdown initiated", { signal });
      await closeSessions();
      await shutdownServer(server);
      logger.info("shutdown complete");
      process.exit(0);
    }

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  })
  .catch((err) => {
    logger.error("failed to start server", { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err: err.message, stack: err.stack });
});
