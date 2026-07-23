import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "pg";

/**
 * rate-limit.ts window semantics against a real Postgres — the CASE-based
 * reset SQL (increment within the window, reset once elapsed) can only be
 * proven server-side. Gated on RUN_LIVE_E2E=1 (integration setup.ts loads env)
 * and DATABASE_URL. Drives the REAL checkRateLimit via db.execute, then
 * back-dates window_start to simulate an elapsed window.
 */
const LIVE = process.env.RUN_LIVE_E2E === "1";
const URL = process.env.DATABASE_URL ?? "";
const KEY = `__rl_test__${process.pid}`;

async function raw(sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

describe.skipIf(!LIVE)("checkRateLimit window (live pg)", () => {
  beforeEach(async () => {
    await raw(`delete from rate_limit_app where key = $1`, [KEY]);
  });
  afterAll(async () => {
    await raw(`delete from rate_limit_app where key = $1`, [KEY]);
  });

  it("increments within the window and blocks past max", async () => {
    const { checkRateLimit } = await import("@/shared/lib/rate-limit");
    const opts = { key: KEY, window: 60, max: 3 };

    expect((await checkRateLimit(opts)).count).toBe(1);
    expect((await checkRateLimit(opts)).count).toBe(2);
    const third = await checkRateLimit(opts);
    expect(third.count).toBe(3);
    expect(third.ok).toBe(true);
    const fourth = await checkRateLimit(opts);
    expect(fourth.count).toBe(4);
    expect(fourth.ok).toBe(false); // over max=3
  });

  it("resets count to 1 once the window has elapsed", async () => {
    const { checkRateLimit } = await import("@/shared/lib/rate-limit");
    const opts = { key: KEY, window: 60, max: 3 };

    await checkRateLimit(opts);
    await checkRateLimit(opts); // count=2, window open

    // Back-date the window start beyond the 60s window → next call must reset.
    await raw(
      `update rate_limit_app set window_start = now() - interval '120 seconds' where key = $1`,
      [KEY],
    );

    const afterReset = await checkRateLimit(opts);
    expect(afterReset.count).toBe(1);
    expect(afterReset.ok).toBe(true);
  });
});
