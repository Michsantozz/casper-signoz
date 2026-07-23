import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Central bot-ownership guard (assertBotOwner / isBotOwner). This is the
 * security boundary for every by-botId Recall read/write: it decides whether
 * the caller may touch a bot at all, BEFORE any Recall fetch.
 *
 * Ownership is authoritative in two layers, checked in order:
 *  1. meeting_records (RLS-scoped via withUserScope) — the recorded meeting;
 *  2. recall_bots.metadata.user_id — the scheduled-but-not-recorded bot.
 *
 * Fail-closed: no session/no match → not owner. Repos + RLS are mocked so we
 * assert the resolution logic, not Postgres.
 */

const findMeetingRecord = vi.fn();
const findBotByBotId = vi.fn();
// withUserScope must forward the userId AND run fn under it — the record lookup
// only "sees" the row when scoped to its owner.
const withUserScope = vi.fn((_userId: string, fn: () => unknown) => fn());

vi.mock("@/server/recall/meeting-repository", () => ({
  findMeetingRecord: (...a: unknown[]) => findMeetingRecord(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  // Real helper: reads metadata.user_id off the row (or null).
  botOwnerUserId: (row: { metadata?: { user_id?: unknown } } | null) => {
    const uid = row?.metadata?.user_id;
    return typeof uid === "string" ? uid : null;
  },
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (userId: string, fn: () => unknown) =>
    withUserScope(userId, fn),
}));

async function load() {
  return import("@/server/recall/ownership");
}

beforeEach(() => {
  vi.clearAllMocks();
  findMeetingRecord.mockResolvedValue(null);
  findBotByBotId.mockResolvedValue(null);
});

describe("isBotOwner", () => {
  it("owner via meeting_records (recorded meeting) → true, scoped to userId", async () => {
    findMeetingRecord.mockResolvedValue({ botId: "bot-1", userId: "u1" });
    const { isBotOwner } = await load();

    expect(await isBotOwner("bot-1", "u1")).toBe(true);
    // The record lookup ran under the caller's RLS scope.
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    // Recorded match short-circuits — no need to touch recall_bots.
    expect(findBotByBotId).not.toHaveBeenCalled();
  });

  it("owner via recall_bots.metadata (scheduled, not yet recorded) → true", async () => {
    findMeetingRecord.mockResolvedValue(null);
    findBotByBotId.mockResolvedValue({ metadata: { user_id: "u1" } });
    const { isBotOwner } = await load();

    expect(await isBotOwner("bot-1", "u1")).toBe(true);
  });

  it("bot owned by another user → false", async () => {
    // RLS: another user's record is invisible under u1's scope → null.
    findMeetingRecord.mockResolvedValue(null);
    findBotByBotId.mockResolvedValue({ metadata: { user_id: "someone-else" } });
    const { isBotOwner } = await load();

    expect(await isBotOwner("bot-1", "u1")).toBe(false);
  });

  it("unknown bot (no record, no mapping) → false", async () => {
    const { isBotOwner } = await load();
    expect(await isBotOwner("ghost", "u1")).toBe(false);
  });

  it("empty botId or userId → false without any lookup (fail-closed)", async () => {
    const { isBotOwner } = await load();
    expect(await isBotOwner("", "u1")).toBe(false);
    expect(await isBotOwner("bot-1", "")).toBe(false);
    expect(findMeetingRecord).not.toHaveBeenCalled();
    expect(findBotByBotId).not.toHaveBeenCalled();
  });
});

describe("assertBotOwner", () => {
  it("owner → resolves without throwing", async () => {
    findMeetingRecord.mockResolvedValue({ botId: "bot-1", userId: "u1" });
    const { assertBotOwner } = await load();
    await expect(assertBotOwner("bot-1", "u1")).resolves.toBeUndefined();
  });

  it("non-owner → throws a non-enumerating message", async () => {
    findBotByBotId.mockResolvedValue({ metadata: { user_id: "other" } });
    const { assertBotOwner } = await load();
    // Message must not distinguish "not found" from "not yours".
    await expect(assertBotOwner("bot-1", "u1")).rejects.toThrow(
      /not found or not accessible/i,
    );
  });
});
