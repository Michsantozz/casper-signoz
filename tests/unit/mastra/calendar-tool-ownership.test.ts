import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * calendar.tool.ts — tenant isolation. The calendar owner is the session user;
 * the agent never passes a user_id. These tools MUST refuse a calendar/event
 * that isn't the session user's, and MUST refuse an unauthenticated caller,
 * BEFORE any mutating Recall/Google call. Regression guard for a cross-tenant
 * calendar leak.
 *
 * We mock the session, the calendar repo (ownership source), and every network
 * dependency, then drive the tools' execute directly.
 */
const getSession = vi.fn();
const findCalendarById = vi.fn();
const listCalendarsByUser = vi.fn();
const recallFetch = vi.fn();
const listCalendarEvents = vi.fn();
const getCalendarAccessToken = vi.fn();
const createGoogleEvent = vi.fn();
const getDayAvailability = vi.fn();
const saveBotMapping = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/calendar-repository", () => ({
  findCalendarById: (...a: unknown[]) => findCalendarById(...a),
  listCalendarsByUser: (...a: unknown[]) => listCalendarsByUser(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
  RecallAdhocPoolError: class extends Error {},
}));
vi.mock("@/server/recall/calendars", () => ({
  listCalendarEvents: (...a: unknown[]) => listCalendarEvents(...a),
  getCalendarAccessToken: (...a: unknown[]) => getCalendarAccessToken(...a),
}));
vi.mock("@/server/recall/google-calendar", () => ({
  createGoogleEvent: (...a: unknown[]) => createGoogleEvent(...a),
}));
vi.mock("@/server/recall/availability", () => ({
  getDayAvailability: (...a: unknown[]) => getDayAvailability(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  saveBotMapping: (...a: unknown[]) => saveBotMapping(...a),
  // Mirror the real signature (userId, meetingUrl, joinAt?) so the dedup key is
  // namespaced per tenant — see the #3 assertion below.
  defaultDedupKey: (userId: string, url: string, joinAt?: string) =>
    `${userId}:${joinAt ?? "adhoc"}-${url}`,
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (_u: string, fn: () => unknown) => fn(),
}));

type ToolExec = (input: unknown) => Promise<unknown>;
async function tool(name: string): Promise<ToolExec> {
  const mod = (await import("@/mastra/tools/calendar.tool")) as unknown as Record<
    string,
    { execute: ToolExec }
  >;
  return mod[name].execute;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
});

describe("calendar tools — authentication guard", () => {
  it("every tool rejects an unauthenticated caller", async () => {
    getSession.mockResolvedValue(null);
    // A schema-valid input per tool, so we reach the auth guard (not schema
    // validation) — createTool validates inputSchema before execute.
    const cases: Array<[string, unknown]> = [
      ["listCalendarEventsTool", {}],
      ["scheduleBotForEventTool", { eventId: "e" }],
      ["removeBotFromEventTool", { eventId: "e" }],
      [
        "createCalendarEventTool",
        {
          summary: "x",
          startIso: "2026-07-11T10:00:00-03:00",
          endIso: "2026-07-11T11:00:00-03:00",
        },
      ],
      ["getFreeSlotsTool", { dateIso: "2026-07-11" }],
    ];
    for (const [name, input] of cases) {
      const exec = await tool(name);
      await expect(exec(input)).rejects.toThrow(/not authenticated/i);
    }
    // No network side-effect for an unauthenticated call.
    expect(recallFetch).not.toHaveBeenCalled();
    expect(createGoogleEvent).not.toHaveBeenCalled();
  });
});

describe("calendar tools — tenant isolation (assertOwnedCalendar)", () => {
  it("list: a calendarId not owned by the user is refused, no Recall call", async () => {
    findCalendarById.mockResolvedValue(null); // not this user's calendar
    const exec = await tool("listCalendarEventsTool");
    await expect(exec({ calendarId: "other-cal" })).rejects.toThrow(
      /not found for this user/i,
    );
    expect(listCalendarEvents).not.toHaveBeenCalled();
  });

  it("list: a calendar owned by ANOTHER user is refused (userId mismatch)", async () => {
    findCalendarById.mockResolvedValue({ id: "c", userId: "someone-else" });
    const exec = await tool("listCalendarEventsTool");
    await expect(exec({ calendarId: "c" })).rejects.toThrow(
      /not found for this user/i,
    );
    expect(listCalendarEvents).not.toHaveBeenCalled();
  });

  it("schedule_bot: event on a foreign calendar is refused before scheduling", async () => {
    recallFetch.mockResolvedValueOnce({ id: "e", calendar_id: "foreign-cal" });
    findCalendarById.mockResolvedValue({ id: "foreign-cal", userId: "someone-else" });
    const exec = await tool("scheduleBotForEventTool");
    await expect(exec({ eventId: "e" })).rejects.toThrow(/not found for this user/i);
    // GET happened, but the POST that schedules the bot must NOT.
    expect(recallFetch).toHaveBeenCalledTimes(1);
  });

  it("remove_bot: event on a foreign calendar is refused before delete", async () => {
    recallFetch.mockResolvedValueOnce({ id: "e", calendar_id: "foreign-cal" });
    findCalendarById.mockResolvedValue({ id: "foreign-cal", userId: "someone-else" });
    const exec = await tool("removeBotFromEventTool");
    await expect(exec({ eventId: "e" })).rejects.toThrow(/not found for this user/i);
    expect(recallFetch).toHaveBeenCalledTimes(1); // GET only, no DELETE
  });
});

describe("calendar tools — happy path scopes to the session user", () => {
  it("schedule_bot dedup key is derived from the SESSION user, not input", async () => {
    recallFetch
      .mockResolvedValueOnce({ id: "e", calendar_id: "c" }) // GET event
      .mockResolvedValueOnce({ id: "e", bots: [{ id: "b" }] }); // POST bot
    findCalendarById.mockResolvedValue({ id: "c", userId: "u1" });
    const exec = await tool("scheduleBotForEventTool");

    await exec({ eventId: "e" });

    const postCall = recallFetch.mock.calls[1][0];
    expect(postCall.body.deduplication_key).toBe("u1:e");
  });

  it("create_event with sendBot persists a recall_bots dedup key namespaced by the session user (#3)", async () => {
    // With sendBot, the tool ALSO writes a recall_bots mapping. Its local dedup
    // key must be namespaced by the session user so two tenants scheduling the
    // same meeting URL don't collide on one PK (that table has no RLS).
    listCalendarsByUser.mockResolvedValue([
      { recallCalendarId: "c", platform: "google_calendar", userId: "u1" },
    ]);
    getCalendarAccessToken.mockResolvedValue({ token: "tok" });
    createGoogleEvent.mockResolvedValue({ id: "ev1", meetingUrl: "https://meet/x" });
    recallFetch.mockResolvedValue({ id: "bot-1" }); // POST bot
    const exec = await tool("createCalendarEventTool");

    await exec({
      summary: "x",
      startIso: "2026-07-11T10:00:00-03:00",
      endIso: "2026-07-11T11:00:00-03:00",
      sendBot: true,
    });

    expect(saveBotMapping).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: expect.stringContaining("u1:") }),
    );
  });

  it("create_event fails when the user has no Google calendar connected", async () => {
    listCalendarsByUser.mockResolvedValue([]); // none connected
    const exec = await tool("createCalendarEventTool");
    await expect(
      exec({ summary: "x", startIso: "2026-07-11T10:00:00-03:00", endIso: "2026-07-11T11:00:00-03:00" }),
    ).rejects.toThrow(/no google calendar/i);
    expect(createGoogleEvent).not.toHaveBeenCalled();
  });
});
