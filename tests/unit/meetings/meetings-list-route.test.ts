import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GET /api/meetings — paginated meetings library. Contract:
 *  - no session → 401, no repo call (fail-closed);
 *  - with session → runs the page query UNDER withUserScope(userId) (RLS) and
 *    returns { meetings, nextCursor };
 *  - query params (q/status/cursor) are forwarded to the repo;
 *  - scheduled bots are merged ONLY on the first unfiltered page (no
 *    cursor/q/status); a searched or paged request returns pure recorded rows.
 *
 * Server-only libs (repo/session/RLS) are mocked to isolate the route.
 */

const getSession = vi.fn();
const listMeetingRecordsPage = vi.fn();
const isMeetingStatus = vi.fn((s: string) =>
  ["done", "processing", "pending", "failed"].includes(s),
);
const listUpcomingBotsForUser = vi.fn();
const withUserScope = vi.fn((_userId: string, fn: () => unknown) => fn());

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  listMeetingRecordsPage: (...a: unknown[]) => listMeetingRecordsPage(...a),
  isMeetingStatus: (...a: [string]) => isMeetingStatus(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  listUpcomingBotsForUser: (...a: unknown[]) => listUpcomingBotsForUser(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (userId: string, fn: () => unknown) =>
    withUserScope(userId, fn),
}));
// Route throttles via checkRateLimit (hits pg) — stub it to always allow so the
// unit test needs no DB.
vi.mock("@/shared/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ ok: true, count: 1, retryAfter: 0 })),
}));

function req(query = ""): Request {
  return new Request(`http://x/api/meetings${query}`);
}
async function call(query = ""): Promise<Response> {
  const { GET } = await import("@/app/api/meetings/route");
  return GET(req(query));
}

beforeEach(() => {
  vi.clearAllMocks();
  listUpcomingBotsForUser.mockResolvedValue([]);
  listMeetingRecordsPage.mockResolvedValue({ items: [], nextCursor: null });
});

describe("GET /api/meetings — auth gate", () => {
  it("no session → 401 and no repo call", async () => {
    getSession.mockResolvedValue(null);
    const res = await call();

    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unauthenticated");
    expect(listMeetingRecordsPage).not.toHaveBeenCalled();
    expect(withUserScope).not.toHaveBeenCalled();
  });

  it("session without user.id → 401", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await call();
    expect(res.status).toBe(401);
    expect(listMeetingRecordsPage).not.toHaveBeenCalled();
  });
});

describe("GET /api/meetings — scoped, paginated read", () => {
  it("runs the page query under withUserScope and returns { meetings, nextCursor }", async () => {
    getSession.mockResolvedValue({ user: { id: "user-42" } });
    listMeetingRecordsPage.mockResolvedValue({
      items: [
        {
          botId: "bot-1",
          status: "done",
          meetingUrl: "https://meet/x",
          summary: "Summary",
          participantCount: 3,
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
      nextCursor: "2026-07-01T10:00:00.000Z",
    });

    const res = await call();
    expect(res.status).toBe(200);
    expect(withUserScope).toHaveBeenCalledWith("user-42", expect.any(Function));
    const json = (await res.json()) as {
      meetings: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(json.meetings[0]).toMatchObject({ botId: "bot-1", joinAt: null });
    expect(json.nextCursor).toBe("2026-07-01T10:00:00.000Z");
  });

  it("forwards q/status/cursor to the repo and does NOT merge scheduled", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    listUpcomingBotsForUser.mockResolvedValue([
      {
        botId: "sch-1",
        meetingUrl: "https://meet/sch",
        joinAt: new Date(Date.now() + 3_600_000),
      },
    ]);

    const res = await call("?q=pricing&status=done&cursor=2026-06-01T00:00:00.000Z");
    const json = (await res.json()) as { meetings: unknown[] };

    expect(listMeetingRecordsPage).toHaveBeenCalledWith({
      query: "pricing",
      status: "done",
      cursor: "2026-06-01T00:00:00.000Z",
      limit: undefined,
    });
    // Filtered/paged request → scheduled bots are NOT fetched or merged.
    expect(listUpcomingBotsForUser).not.toHaveBeenCalled();
    expect(json.meetings).toEqual([]);
  });

  it("ignores an invalid status filter", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    await call("?status=bogus");
    expect(listMeetingRecordsPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: undefined }),
    );
  });
});

describe("GET /api/meetings — scheduled merge (first unfiltered page)", () => {
  it("scheduled rows come first, recorded after", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const future = new Date(Date.now() + 3_600_000);
    listMeetingRecordsPage.mockResolvedValue({
      items: [
        {
          botId: "rec-1",
          status: "done",
          meetingUrl: "https://meet/rec",
          summary: "Recorded",
          participantCount: 2,
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    listUpcomingBotsForUser.mockResolvedValue([
      { botId: "sch-1", meetingUrl: "https://meet/sch", joinAt: future },
    ]);

    const res = await call();
    const json = (await res.json()) as { meetings: Array<Record<string, unknown>> };

    expect(json.meetings).toHaveLength(2);
    expect(json.meetings[0]).toMatchObject({
      botId: "sch-1",
      status: "scheduled",
      joinAt: future.toISOString(),
    });
    expect(json.meetings[1]).toMatchObject({ botId: "rec-1", status: "done" });
  });

  it("dedup: a scheduled bot that already recorded shows once (as recorded)", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const future = new Date(Date.now() + 3_600_000);
    listMeetingRecordsPage.mockResolvedValue({
      items: [
        {
          botId: "dup",
          status: "done",
          meetingUrl: "https://meet/dup",
          summary: "Recorded",
          participantCount: 1,
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    listUpcomingBotsForUser.mockResolvedValue([
      { botId: "dup", meetingUrl: "https://meet/dup", joinAt: future },
    ]);

    const res = await call();
    const json = (await res.json()) as { meetings: Array<Record<string, unknown>> };

    expect(json.meetings).toHaveLength(1);
    expect(json.meetings[0]).toMatchObject({ botId: "dup", status: "done" });
  });
});
