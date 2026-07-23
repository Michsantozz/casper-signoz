import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Referential-integrity regression for migration 0019 — needs a real Postgres.
 *
 * The fixes add DB-level constraints that no application code can bypass:
 *  - user_calendars.user_id  → user.id  ON DELETE CASCADE  (delete user, calendars go)
 *  - meeting_records.user_id → user.id  ON DELETE SET NULL (delete user, minutes survive ownerless)
 *  - UNIQUE (user_id, platform_email, platform) on user_calendars (no duplicate links)
 *
 * These are enforced by the engine, so they only prove out against a real
 * Postgres with the migration applied. Gated on RUN_LIVE_E2E=1 and pointed at
 * DATABASE_URL.
 * Run: RUN_LIVE_E2E=1 pnpm test:integration integrity-constraints
 */
const LIVE = process.env.RUN_LIVE_E2E === "1";
const URL = process.env.DATABASE_URL ?? "";
const U1 = `__integrity_u1__${process.pid}`;
const U2 = `__integrity_u2__${process.pid}`;
const CAL = `__integrity_cal__${process.pid}`;
const BOT = `__integrity_bot__${process.pid}`;

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function q(sql: string, params: unknown[] = []) {
  return withClient((c) => c.query(sql, params));
}

async function seedUser(id: string) {
  await q(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'T', $2, false, now(), now())
     on conflict (id) do nothing`,
    [id, `${id}@example.test`],
  );
}

async function cleanup() {
  await q(`delete from meeting_records where bot_id like $1`, [`__integrity_bot__%`]);
  await q(`delete from user_calendars where recall_calendar_id like $1`, [
    `__integrity_cal__%`,
  ]);
  await q(`delete from "user" where id in ($1, $2)`, [U1, U2]);
}

describe.skipIf(!LIVE)("referential integrity (live pg, migration 0019)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("cascades user_calendars when the owning user is deleted", async () => {
    await seedUser(U1);
    await q(
      `insert into user_calendars (recall_calendar_id, user_id, platform, platform_email, status)
       values ($1, $2, 'google_calendar', 'a@x.test', 'connected')`,
      [CAL, U1],
    );

    await q(`delete from "user" where id=$1`, [U1]);

    const rows = await q(
      `select 1 from user_calendars where recall_calendar_id=$1`,
      [CAL],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("nulls meeting_records.user_id when the owning user is deleted (minutes survive)", async () => {
    await seedUser(U1);
    await q(
      `insert into meeting_records (bot_id, user_id, status) values ($1, $2, 'done')`,
      [BOT, U1],
    );

    await q(`delete from "user" where id=$1`, [U1]);

    const rows = await q(
      `select user_id from meeting_records where bot_id=$1`,
      [BOT],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].user_id).toBeNull();
  });

  it("rejects an invalid meeting_records owner id (FK, not silent orphan)", async () => {
    await expect(
      q(`insert into meeting_records (bot_id, user_id, status) values ($1, $2, 'pending')`, [
        BOT,
        "__no_such_user__",
      ]),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("rejects a duplicate (user, platform_email, platform) calendar link", async () => {
    await seedUser(U1);
    await q(
      `insert into user_calendars (recall_calendar_id, user_id, platform, platform_email, status)
       values ($1, $2, 'google_calendar', 'dup@x.test', 'connected')`,
      [CAL, U1],
    );

    await expect(
      q(
        `insert into user_calendars (recall_calendar_id, user_id, platform, platform_email, status)
         values ($1, $2, 'google_calendar', 'dup@x.test', 'connected')`,
        [`${CAL}_2`, U1],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows the SAME email+platform for two DIFFERENT users (tenant-scoped uniqueness)", async () => {
    await seedUser(U1);
    await seedUser(U2);
    await q(
      `insert into user_calendars (recall_calendar_id, user_id, platform, platform_email, status)
       values ($1, $2, 'google_calendar', 'shared@x.test', 'connected')`,
      [CAL, U1],
    );

    await expect(
      q(
        `insert into user_calendars (recall_calendar_id, user_id, platform, platform_email, status)
         values ($1, $2, 'google_calendar', 'shared@x.test', 'connected')`,
        [`${CAL}_2`, U2],
      ),
    ).resolves.toBeDefined();
  });
});
