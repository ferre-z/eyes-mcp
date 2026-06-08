// =============================================================================
// Eyes-MCP — Winston logger
// JSON in production, pretty in development. All other modules import `logger`
// and `createRequestLogger` from here.
// =============================================================================

import winston from "winston";
import { randomUUID } from "node:crypto";

const LOG_LEVEL = process.env["EYES_LOG_LEVEL"] ?? "info";
const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const IS_PROD = NODE_ENV === "production";

const prettyFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, requestId, ...rest }) => {
    const rid = requestId ? ` [${String(requestId).slice(0, 8)}]` : "";
    const tail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
    return `${timestamp}${rid} ${level.padEnd(5)} ${message}${tail}`;
  }),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const logger: winston.Logger = winston.createLogger({
  level: LOG_LEVEL,
  format: IS_PROD ? jsonFormat : prettyFormat,
  defaultMeta: { service: "eyes-mcp" },
  transports: [new winston.transports.Console()],
  // Don't crash on uncaught handler errors.
  exitOnError: false,
});

/**
 * Create a child logger that tags every entry with a request id. Use this
 * for the lifetime of a single MCP request so logs are correlatable.
 */
export function createRequestLogger(requestId: string = randomUUID()): winston.Logger {
  return logger.child({ requestId });
}
