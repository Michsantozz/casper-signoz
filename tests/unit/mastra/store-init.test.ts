import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `ensureMastraStoreInit` — memoizes `PostgresStore.init()` to a single shared
 * promise per process. `init()` runs schema DDL through ONE pinned backend
 * connection (RoutingDbClient) and throws if a client is already pinned, so two
 * cold-store operations that each trigger a lazy init concurrently collide with
 * "already has a pinned client". This guard serializes init so pin/unpin never
 * overlap. Contract:
 *  - init() runs exactly once across concurrent + repeat callers;
 *  - a failed init is NOT cached — the next caller retries.
 *
 * We mock the PostgresStore/PgVector ctors so no real Postgres is touched, and
 * reset the module registry between tests to clear the memoized promise (it's
 * stored on globalThis, so we also clear that).
 */

const init = vi.fn();

vi.mock("@mastra/pg", () => ({
  PostgresStore: class {
    init = init;
  },
  PgVector: class {},
}));

type G = {
  __mastraStore?: unknown;
  __mastraVector?: unknown;
  __mastraStoreInit?: unknown;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // Clear the process-global singletons the module writes to.
  const g = globalThis as unknown as G;
  g.__mastraStore = undefined;
  g.__mastraVector = undefined;
  g.__mastraStoreInit = undefined;
  process.env.DATABASE_URL = "postgres://x/y";
});

async function load() {
  return import("@/mastra/storage");
}

describe("ensureMastraStoreInit", () => {
  it("runs init() exactly once across many concurrent callers", async () => {
    init.mockResolvedValue(undefined);
    const { ensureMastraStoreInit } = await load();

    await Promise.all([
      ensureMastraStoreInit(),
      ensureMastraStoreInit(),
      ensureMastraStoreInit(),
    ]);

    expect(init).toHaveBeenCalledTimes(1);
  });

  it("does not re-run init() on a later call once resolved", async () => {
    init.mockResolvedValue(undefined);
    const { ensureMastraStoreInit } = await load();

    await ensureMastraStoreInit();
    await ensureMastraStoreInit();

    expect(init).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failed init — the next call retries", async () => {
    init.mockRejectedValueOnce(new Error("db cold")).mockResolvedValue(undefined);
    const { ensureMastraStoreInit } = await load();

    await expect(ensureMastraStoreInit()).rejects.toThrow("db cold");
    // Retry succeeds — the failed promise was cleared, not memoized.
    await expect(ensureMastraStoreInit()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(2);
  });
});
