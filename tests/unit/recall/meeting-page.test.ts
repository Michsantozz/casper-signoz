import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * listMeetingRecordsPage — the paginated "library" query. Covers:
 *  - keyset pagination: fetches limit+1 and derives nextCursor from the last
 *    item when a further page exists (null when exhausted);
 *  - the nextCursor is the COMPOSITE `${createdAtIso}|${botId}` keyset cursor
 *    (the botId tiebreaker keeps pages stable when createdAt collides);
 *  - a composite cursor applies a row-value `(created_at, bot_id) < (…)` predicate;
 *  - a legacy createdAt-only cursor still works (falls back to `lt`);
 *  - server-side search + status conditions are added to the WHERE tree;
 *  - the ORDER BY carries the (created_at DESC, bot_id DESC) tiebreaker;
 *  - isMeetingStatus validates against the enum.
 *
 * scopedDb() is mocked with a chainable fake builder; we inspect where/orderBy/limit.
 * The RLS boundary (withUserScope) is exercised at the route/tool level.
 */

const capture: { where: unknown; orderBy: unknown[]; limit: number | null } = {
  where: null,
  orderBy: [],
  limit: null,
};
let rows: Array<Record<string, unknown>> = [];

const qb = {
  select: () => qb,
  from: () => qb,
  where: (w: unknown) => {
    capture.where = w;
    return qb;
  },
  orderBy: (...cols: unknown[]) => {
    capture.orderBy = cols;
    return qb;
  },
  limit: (n: number) => {
    capture.limit = n;
    return Promise.resolve(rows);
  },
};

// `desc(col)` needs to be callable both as desc(col) AND col.desc() — the
// schema columns expose a .desc() method the repo's index def uses, while the
// query uses desc(col). Model column tokens with a .desc() that mirrors desc().
function col(name: string) {
  return { name, desc: () => ({ op: "desc", col: { name } }) };
}

vi.mock("@/shared/db/rls", () => ({ scopedDb: () => qb }));
// `sql` is used as a TEMPLATE TAG for the composite-cursor row-value predicate:
// sql`(${createdAt}, ${botId}) < (${d.createdAt}, ${d.botId})`. Capture the
// interpolated values so the test can assert the row-value comparison shape.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ op: "and", args: a }),
  or: (...a: unknown[]) => ({ op: "or", args: a }),
  eq: (colArg: unknown, val: unknown) => ({ op: "eq", col: colArg, val }),
  ilike: (colArg: unknown, pattern: unknown) => ({ op: "ilike", col: colArg, pattern }),
  desc: (colArg: unknown) => ({ op: "desc", col: colArg }),
  inArray: (...a: unknown[]) => ({ op: "inArray", args: a }),
  lt: (colArg: unknown, val: unknown) => ({ op: "lt", col: colArg, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: "sql",
    strings: Array.from(strings),
    values,
  }),
}));
vi.mock("@/shared/db/schema", () => ({
  meetingRecords: {
    botId: col("bot_id"),
    status: col("status"),
    meetingUrl: col("meeting_url"),
    title: col("title"),
    summary: col("summary"),
    overview: col("overview"),
    transcript: col("transcript"),
    talkShares: col("talk_shares"),
    moments: col("moments"),
    sections: col("sections"),
    soundbites: col("soundbites"),
    createdAt: col("created_at"),
    updatedAt: col("updated_at"),
  },
  meetingRecordStatusEnum: {
    enumValues: ["pending", "processing", "done", "failed"],
  },
}));

async function load() {
  return import("@/server/recall/meeting-repository");
}

/** Builds n rows with descending createdAt (newest first, like the query). */
function makeRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    botId: `bot-${i}`,
    status: "done",
    meetingUrl: null,
    title: null,
    summary: `s${i}`,
    talkShares: [{ name: "A", share: 1 }],
    moments: null,
    sections: null,
    soundbites: null,
    createdAt: new Date(Date.UTC(2026, 0, 100 - i)),
    updatedAt: new Date(Date.UTC(2026, 0, 100 - i)),
  }));
}

beforeEach(() => {
  capture.where = null;
  capture.orderBy = [];
  capture.limit = null;
  rows = [];
});

describe("listMeetingRecordsPage — pagination", () => {
  it("fetches limit+1 and returns the composite keyset nextCursor", async () => {
    // limit=2 → asks for 3; return 3 → hasMore.
    rows = makeRows(3);
    const { listMeetingRecordsPage } = await load();

    const page = await listMeetingRecordsPage({ limit: 2 });

    expect(capture.limit).toBe(3);
    expect(page.items).toHaveLength(2);
    // nextCursor = `${createdAtIso}|${botId}` of the last RETURNED item (2nd row).
    const last = rows[1];
    expect(page.nextCursor).toBe(
      `${(last.createdAt as Date).toISOString()}|${last.botId}`,
    );
    // participantCount derived from talkShares length.
    expect(page.items[0].participantCount).toBe(1);
  });

  it("no further page → nextCursor null", async () => {
    rows = makeRows(2);
    const { listMeetingRecordsPage } = await load();

    const page = await listMeetingRecordsPage({ limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("orders by (created_at DESC, bot_id DESC) — the keyset tiebreaker", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();
    await listMeetingRecordsPage({});

    // Two ORDER BY terms, both desc; second is the bot_id tiebreaker.
    expect(capture.orderBy).toHaveLength(2);
    const ob = JSON.stringify(capture.orderBy);
    expect(ob).toContain("created_at");
    expect(ob).toContain("bot_id");
    expect((capture.orderBy as Array<{ op: string }>).every((c) => c.op === "desc")).toBe(true);
  });

  it("clamps limit to 1..100", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({ limit: 999 });
    expect(capture.limit).toBe(101); // 100 + 1

    await listMeetingRecordsPage({ limit: 0 });
    expect(capture.limit).toBe(2); // 1 + 1
  });
});

describe("listMeetingRecordsPage — filters", () => {
  it("adds ILIKE search and status eq to the WHERE tree", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({ query: "pricing", status: "done" });

    const where = JSON.stringify(capture.where);
    expect(where).toContain("ilike");
    expect(where).toContain("pricing");
    expect(where).toContain('"op":"eq"');
  });

  it("composite cursor → row-value (created_at, bot_id) < (…) predicate", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({
      cursor: "2026-06-01T00:00:00.000Z|bot-42",
    });

    const where = JSON.stringify(capture.where);
    // The composite predicate is built via sql`…` — an op:"sql" node whose
    // interpolated values carry the decoded cursor (Date + botId).
    expect(where).toContain('"op":"sql"');
    expect(where).toContain("2026-06-01T00:00:00.000Z");
    expect(where).toContain("bot-42");
    // NOT the legacy lt fallback.
    expect(where).not.toContain('"op":"lt"');
  });

  it("legacy createdAt-only cursor → falls back to lt (no 500)", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    await listMeetingRecordsPage({ cursor: "2026-06-01T00:00:00.000Z" });

    const where = JSON.stringify(capture.where);
    expect(where).toContain('"op":"lt"');
    expect(where).not.toContain('"op":"sql"');
  });

  it("garbage cursor → ignored (no cursor predicate, no throw)", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();

    // Neither a valid composite nor a parseable date.
    await listMeetingRecordsPage({ cursor: "not-a-cursor" });

    // No filters at all survive → WHERE undefined.
    expect(capture.where).toBeUndefined();
  });

  it("no filters → WHERE is undefined (unfiltered listing)", async () => {
    rows = [];
    const { listMeetingRecordsPage } = await load();
    await listMeetingRecordsPage({});
    expect(capture.where).toBeUndefined();
  });
});

describe("isMeetingStatus", () => {
  it("accepts enum values, rejects others", async () => {
    const { isMeetingStatus } = await load();
    expect(isMeetingStatus("done")).toBe(true);
    expect(isMeetingStatus("failed")).toBe(true);
    expect(isMeetingStatus("scheduled")).toBe(false);
    expect(isMeetingStatus("bogus")).toBe(false);
  });
});
