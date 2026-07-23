import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * logger (pino) — central structured logger. Contract:
 *  - createLogger(module) returns a child logger tagged with `module`, so every
 *    line carries `{ module: "<name>" }` for filtering;
 *  - the root level honors LOG_LEVEL (default `info`);
 *  - it's server-only (pino is Node-runtime; must not reach the client bundle).
 *
 * The module reads NODE_ENV/LOG_LEVEL at import time, so each test resets the
 * registry and re-imports with the env it wants. We force NODE_ENV!=production
 * off for the level test by pinning LOG_LEVEL explicitly.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL };
  // Avoid the pino-pretty transport (spawns a worker thread) in tests: pretend
  // we're in production so the logger is a plain JSON pino instance.
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL };
});

describe("createLogger", () => {
  it("tags child logs with the module name", async () => {
    const { createLogger } = await import("@/shared/lib/logger");
    const log = createLogger("media");
    expect(log.bindings().module).toBe("media");
  });

  it("distinct modules get distinct bindings", async () => {
    const { createLogger } = await import("@/shared/lib/logger");
    expect(createLogger("enrich").bindings().module).toBe("enrich");
    expect(createLogger("s3").bindings().module).toBe("s3");
  });

  it("exposes the standard pino level methods", async () => {
    const { createLogger } = await import("@/shared/lib/logger");
    const log = createLogger("x");
    for (const m of ["error", "warn", "info", "debug"] as const) {
      expect(typeof log[m]).toBe("function");
    }
  });
});

describe("root logger level", () => {
  it("defaults to info when LOG_LEVEL is unset", async () => {
    delete process.env.LOG_LEVEL;
    const { logger } = await import("@/shared/lib/logger");
    expect(logger.level).toBe("info");
  });

  it("honors LOG_LEVEL from the env", async () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const { logger } = await import("@/shared/lib/logger");
    expect(logger.level).toBe("debug");
  });

  it("child inherits the root level", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const { createLogger } = await import("@/shared/lib/logger");
    expect(createLogger("y").level).toBe("warn");
  });
});
