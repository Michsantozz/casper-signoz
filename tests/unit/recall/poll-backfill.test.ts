import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * poll-backfill (#2): discovers Recall bots with a ready transcript that never
 * got a meeting_record (lost webhook) and enqueues them. Idempotent via
 * enqueueMeetingRecord's onConflictDoNothing.
 *
 * Deps (recallFetch / repo / bot-repo / rls) are mocked; withSystemScope just
 * runs the fn. We assert: only ready-transcript bots are enqueued, ownership is
 * resolved (repo → metadata), orphans warn, and pagination follows `next`
 * bounded by maxPages.
 */

const recallFetch = vi.fn();
const enqueueMeetingRecord = vi.fn();
const findBotByBotId = vi.fn();
const botOwnerUserId = vi.fn();

vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  enqueueMeetingRecord: (...a: unknown[]) => enqueueMeetingRecord(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  botOwnerUserId: (...a: unknown[]) => botOwnerUserId(...a),
  resolveBotOwner: (row: unknown, supplied: unknown) => {
    const persisted = botOwnerUserId(row);
    if (persisted && typeof supplied === "string" && persisted !== supplied) {
      return { userId: null, conflict: true };
    }
    return {
      userId: persisted ?? (typeof supplied === "string" ? supplied : null),
      conflict: false,
    };
  },
}));
vi.mock("@/shared/db/rls", () => ({
  withSystemScope: (fn: () => unknown) => fn(),
}));

const logSpy = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock("@/shared/lib/logger", () => ({
  createLogger: () => logSpy,
  logger: logSpy,
}));

/** A bot with a transcript in the given status. */
function bot(id: string, transcriptCode: string, metadata?: unknown) {
  return {
    id,
    metadata,
    recordings: [
      { media_shortcuts: { transcript: { status: { code: transcriptCode } } } },
    ],
  };
}

async function load() {
  return import("@/server/recall/poll-backfill");
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [recallFetch, enqueueMeetingRecord, findBotByBotId, botOwnerUserId]) {
    m.mockReset();
  }
  enqueueMeetingRecord.mockResolvedValue(undefined);
  botOwnerUserId.mockReturnValue(null);
  findBotByBotId.mockResolvedValue(null);
});

describe("backfillMissingMeetings", () => {
  it("enqueues only bots with a ready transcript", async () => {
    recallFetch.mockResolvedValue({
      results: [
        bot("ready-1", "done"),
        bot("pending-1", "processing"), // transcript not ready → skip
        bot("ready-2", "done"),
      ],
      next: null,
    });
    // Owner resolves via the repo mapping.
    botOwnerUserId.mockReturnValue("owner-x");

    const { backfillMissingMeetings } = await load();
    const res = await backfillMissingMeetings();

    expect(res.scanned).toBe(3);
    expect(res.enqueued).toBe(2);
    expect(enqueueMeetingRecord).toHaveBeenCalledTimes(2);
    expect(enqueueMeetingRecord).toHaveBeenCalledWith({
      botId: "ready-1",
      userId: "owner-x",
    });
    expect(enqueueMeetingRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: "pending-1" }),
    );
  });

  it("falls back to metadata.user_id when the repo has no mapping", async () => {
    recallFetch.mockResolvedValue({
      results: [bot("ready-1", "done", { user_id: "meta-owner" })],
      next: null,
    });
    findBotByBotId.mockResolvedValue(null);
    botOwnerUserId.mockReturnValue(null); // repo can't resolve

    const { backfillMissingMeetings } = await load();
    await backfillMissingMeetings();

    expect(enqueueMeetingRecord).toHaveBeenCalledWith({
      botId: "ready-1",
      userId: "meta-owner",
    });
  });

  it("warns on an orphan bot but still enqueues it", async () => {
    logSpy.warn.mockReset();
    recallFetch.mockResolvedValue({
      results: [bot("orphan-1", "done")], // no repo owner, no metadata
      next: null,
    });

    const { backfillMissingMeetings } = await load();
    await backfillMissingMeetings();

    expect(enqueueMeetingRecord).toHaveBeenCalledWith({
      botId: "orphan-1",
      userId: null,
    });
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "orphan-1" }),
      expect.stringContaining("orphan bot"),
    );
  });

  it("skips a bot when persisted and provider owners conflict", async () => {
    recallFetch.mockResolvedValue({
      results: [bot("conflict", "done", { user_id: "provider-owner" })],
      next: null,
    });
    findBotByBotId.mockResolvedValue({ metadata: { user_id: "persisted-owner" } });
    botOwnerUserId.mockReturnValue("persisted-owner");

    const { backfillMissingMeetings } = await load();
    await backfillMissingMeetings();

    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
    expect(logSpy.error).toHaveBeenCalled();
  });

  it("follows pagination via `next` cursor", async () => {
    recallFetch
      .mockResolvedValueOnce({
        results: [bot("p1", "done")],
        next: "https://api.recall.ai/api/v1/bot/?cursor=CURSOR2",
      })
      .mockResolvedValueOnce({
        results: [bot("p2", "done")],
        next: null,
      });
    botOwnerUserId.mockReturnValue("owner");

    const { backfillMissingMeetings } = await load();
    const res = await backfillMissingMeetings();

    expect(res.pages).toBe(2);
    expect(res.enqueued).toBe(2);
    // Second call must use the extracted cursor, not the window filter.
    expect(recallFetch).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "v1/bot/",
      query: { cursor: "CURSOR2" },
    });
  });

  it("stops at maxPages even if `next` keeps coming", async () => {
    // Every page points to another → bounded by maxPages.
    recallFetch.mockResolvedValue({
      results: [bot("x", "done")],
      next: "https://api.recall.ai/api/v1/bot/?cursor=NEXT",
    });
    botOwnerUserId.mockReturnValue("owner");

    const { backfillMissingMeetings } = await load();
    const res = await backfillMissingMeetings(24 * 60 * 60_000, 3);

    expect(res.pages).toBe(3);
    expect(recallFetch).toHaveBeenCalledTimes(3);
  });

  it("sends join_at_after window on the first request", async () => {
    recallFetch.mockResolvedValue({ results: [], next: null });

    const { backfillMissingMeetings } = await load();
    await backfillMissingMeetings();

    const firstCall = recallFetch.mock.calls[0][0] as {
      query: Record<string, unknown>;
    };
    expect(firstCall.query).toHaveProperty("join_at_after");
    expect(firstCall.query).toHaveProperty("ordering", "-join_at");
  });
});
