import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * updateMeetingRecord / deleteMeetingRecord — the owner-edit and delete
 * mutations on meeting_records. Covers:
 *  - deleteMeetingRecord: deletes by botId (eq condition), returns the deleted
 *    row when one was removed, null when nothing matched (unknown botId / not
 *    the caller's, filtered out by RLS via scopedDb()).
 *  - updateMeetingRecord: applies the caller's patch AND bumps updatedAt in the
 *    same SET, filters by botId (eq condition), returns the updated row or null.
 *
 * scopedDb() is mocked with a chainable fake builder extended with
 * delete/update/set/returning, same pattern as meeting-page.test.ts.
 */

const capture: {
  where: unknown;
  set: Record<string, unknown> | null;
  op: "delete" | "update" | null;
} = { where: null, set: null, op: null };
let returningRows: Array<Record<string, unknown>> = [];

const qb = {
  delete: () => {
    capture.op = "delete";
    return qb;
  },
  update: () => {
    capture.op = "update";
    return qb;
  },
  set: (patch: Record<string, unknown>) => {
    capture.set = patch;
    return qb;
  },
  where: (w: unknown) => {
    capture.where = w;
    return qb;
  },
  returning: () => Promise.resolve(returningRows),
};

vi.mock("@/shared/db/rls", () => ({ scopedDb: () => qb }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ op: "and", args: a }),
  or: (...a: unknown[]) => ({ op: "or", args: a }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  ilike: (col: unknown, pattern: unknown) => ({ op: "ilike", col, pattern }),
  desc: (col: unknown) => ({ op: "desc", col }),
  inArray: (...a: unknown[]) => ({ op: "inArray", args: a }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  sql: (...a: unknown[]) => ({ op: "sql", args: a }),
}));
vi.mock("@/shared/db/schema", () => ({
  meetingRecords: {
    botId: { name: "bot_id" },
    title: { name: "title" },
    summary: { name: "summary" },
    overview: { name: "overview" },
    actionItems: { name: "action_items" },
    transcriptStruct: { name: "transcript_struct" },
    talkShares: { name: "talk_shares" },
    dynamics: { name: "dynamics" },
    updatedAt: { name: "updated_at" },
  },
  meetingRecordStatusEnum: {
    enumValues: ["pending", "processing", "done", "failed"],
  },
}));

async function load() {
  return import("@/server/recall/meeting-repository");
}

beforeEach(() => {
  capture.where = null;
  capture.set = null;
  capture.op = null;
  returningRows = [];
});

describe("deleteMeetingRecord", () => {
  it("deletes by botId and returns the deleted row", async () => {
    const row = { botId: "bot-1", title: "Standup" };
    returningRows = [row];
    const { deleteMeetingRecord } = await load();

    const result = await deleteMeetingRecord("bot-1");

    expect(capture.op).toBe("delete");
    expect(capture.where).toEqual({
      op: "eq",
      col: { name: "bot_id" },
      val: "bot-1",
    });
    expect(result).toEqual(row);
  });

  it("returns null when nothing was deleted (unknown botId / not the caller's)", async () => {
    returningRows = [];
    const { deleteMeetingRecord } = await load();

    const result = await deleteMeetingRecord("missing-bot");

    expect(capture.op).toBe("delete");
    expect(capture.where).toEqual({
      op: "eq",
      col: { name: "bot_id" },
      val: "missing-bot",
    });
    expect(result).toBeNull();
  });
});

describe("updateMeetingRecord", () => {
  it("applies the patch, bumps updatedAt, filters by botId, returns the updated row", async () => {
    const patch = { title: "New title", summary: "New summary" };
    const updatedRow = { botId: "bot-2", ...patch };
    returningRows = [updatedRow];
    const { updateMeetingRecord } = await load();

    const before = Date.now();
    const result = await updateMeetingRecord("bot-2", patch);
    const after = Date.now();

    expect(capture.op).toBe("update");
    expect(capture.set).toMatchObject(patch);
    expect(capture.set?.updatedAt).toBeInstanceOf(Date);
    const updatedAtMs = (capture.set?.updatedAt as Date).getTime();
    expect(updatedAtMs).toBeGreaterThanOrEqual(before);
    expect(updatedAtMs).toBeLessThanOrEqual(after);
    expect(capture.where).toEqual({
      op: "eq",
      col: { name: "bot_id" },
      val: "bot-2",
    });
    expect(result).toEqual(updatedRow);
  });

  it("returns null when nothing matched (non-owner / unknown botId)", async () => {
    returningRows = [];
    const { updateMeetingRecord } = await load();

    const result = await updateMeetingRecord("bot-3", { title: "X" });

    expect(result).toBeNull();
  });

  it("supports patching jsonb fields (actionItems, transcriptStruct, talkShares, dynamics)", async () => {
    const patch = {
      actionItems: [{ task: "follow up", owner: "alice" }],
      transcriptStruct: [
        { speaker: "A", start: 0, words: [{ text: "hi", start: 0, end: 1 }] },
      ],
      talkShares: [{ name: "A", share: 1 }],
      dynamics: {
        participants: [
          {
            name: "A",
            talkShare: 1,
            talkSeconds: 60,
            turns: 1,
            interruptionsMade: 0,
            interruptionsReceived: 0,
            longestTurnSeconds: 60,
          },
        ],
        totalTalkSeconds: 60,
        turnCount: 1,
        interruptions: 0,
        silenceSeconds: 0,
        balance: 0.5,
        moments: [],
      },
    };
    returningRows = [{ botId: "bot-4", ...patch }];
    const { updateMeetingRecord } = await load();

    await updateMeetingRecord("bot-4", patch);

    expect(capture.set).toMatchObject(patch);
    expect(capture.set?.updatedAt).toBeInstanceOf(Date);
  });
});
