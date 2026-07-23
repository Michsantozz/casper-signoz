import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

/**
 * Concurrency regression for claimMeetingRecord — needs a real Postgres.
 *
 * The bug: webhook-enrich and reconcile-enrich are SEPARATE Inngest functions,
 * so their per-botId concurrency keys don't cross. With the old
 * `UPDATE ... WHERE status IN (...) RETURNING`, N racing claimers all matched
 * the same pending row and all got it back → N parallel enrichments (LLM paid N
 * times, owner notified N times). The fix adds `SELECT ... FOR UPDATE SKIP
 * LOCKED` so exactly one claimer wins and the rest get null.
 *
 * SKIP LOCKED is server-side row locking, so this only proves out against a real
 * Postgres. Gated on RUN_LIVE_E2E=1 (the integration project's setup.ts loads
 * .env.local/.env in that mode) and points at the DB in DATABASE_URL.
 * Run: RUN_LIVE_E2E=1 pnpm test:integration claim-concurrency
 */
const LIVE = process.env.RUN_LIVE_E2E === "1";
const URL = process.env.DATABASE_URL ?? "";
const BOT = `__claim_conc_test__${process.pid}`;
const STALE_MS = 15 * 60_000;

async function q(sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

/** Mirrors claimMeetingRecord's SQL exactly (own connection per claimer). */
async function claim(): Promise<number> {
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    const staleBefore = new Date(Date.now() - STALE_MS);
    const r = await c.query(
      `update meeting_records set status='processing', attempts=attempts+1, updated_at=now()
       where bot_id = (
         select bot_id from meeting_records
         where bot_id=$1 and (status in ('pending','failed')
           or (status='processing' and updated_at < $2))
         for update skip locked
       ) returning bot_id`,
      [BOT, staleBefore],
    );
    return r.rowCount ?? 0;
  } finally {
    await c.end();
  }
}

describe.skipIf(!LIVE)("claimMeetingRecord concurrency (live pg)", () => {
  beforeAll(async () => {
    await q(
      `insert into meeting_records (bot_id, status) values ($1,'pending')
       on conflict (bot_id) do update set status='pending', attempts=0`,
      [BOT],
    );
  });

  afterAll(async () => {
    await q(`delete from meeting_records where bot_id=$1`, [BOT]);
  });

  it("lets exactly one of many concurrent claimers win", async () => {
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => claim()));

    const winners = results.filter((r) => r === 1).length;
    expect(winners).toBe(1);

    const row = await q(
      `select status, attempts from meeting_records where bot_id=$1`,
      [BOT],
    );
    // Exactly one successful UPDATE → attempts incremented once, not N times.
    expect(row.rows[0].status).toBe("processing");
    expect(row.rows[0].attempts).toBe(1);
  });
});
