import "server-only";
import pino, { type Logger } from "pino";

/**
 * Central structured logger (pino) — a leaf util in `shared/lib`.
 *
 * Replaces scattered `console.*` in the server runtime paths (cron / webhook /
 * enrich / chat) with structured JSON that's filterable and correlatable: you
 * can grep by `module`, `botId`, `userId`, or a request id instead of scraping
 * free-form strings out of stdout.
 *
 * Marked `server-only`: pino is a Node-runtime lib and must never reach the
 * client bundle. All current call sites are server-side (server/*, api-routes,
 * mastra), so this boundary costs nothing.
 *
 * - Level: `LOG_LEVEL` env (default `info`; `debug`/`trace` for verbose runs).
 * - Dev: pino-pretty for readable coloured output. Prod: raw JSON lines (one
 *   object per line) ready for a log pipeline (Loki/Datadog/CloudWatch/…).
 * - Prod redacts obvious secret-bearing keys defensively.
 */

const isDev = process.env.NODE_ENV !== "production";

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Structured JSON in prod; human-friendly pretty output in dev.
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }
    : {
        redact: {
          paths: [
            "err.config.headers.authorization",
            "*.authorization",
            "*.password",
            "*.token",
            "*.secret",
          ],
          censor: "[redacted]",
        },
      }),
});

/**
 * Scoped child logger for a module. `log("media")` tags every line with
 * `module: "media"`, so a call site reads:
 *   const log = createLogger("media");
 *   log.error({ err, botId }, "video capture failed");
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
