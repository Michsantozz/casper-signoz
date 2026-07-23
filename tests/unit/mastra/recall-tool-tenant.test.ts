import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * recall.tool.ts — tenant isolation on the two tools an audit flagged:
 *
 *  - scheduleRecallBotTool (#3): the local recall_bots dedup key MUST be
 *    namespaced by the session user, and scheduling without a session MUST be
 *    refused (an ownerless bot is hidden by RLS and can notify no one).
 *  - listScheduledRecallBotsTool (#2): the Recall API key is workspace-wide, so
 *    `v1/bot/` returns EVERY tenant's bots. The tool MUST filter to bots the
 *    caller owns, and refuse an unauthenticated caller.
 *
 * Network + persistence deps are mocked; we drive each tool's execute directly.
 */
const getSession = vi.fn();
const recallFetch = vi.fn();
const findBotByDedupKey = vi.fn();
const saveBotMapping = vi.fn();
const getOrCreateBotMapping = vi.fn();
const isBotOwner = vi.fn();
const assertBotOwner = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
  RecallAdhocPoolError: class extends Error {},
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByDedupKey: (...a: unknown[]) => findBotByDedupKey(...a),
  saveBotMapping: (...a: unknown[]) => saveBotMapping(...a),
  getOrCreateBotMapping: (...a: unknown[]) => getOrCreateBotMapping(...a),
  deleteBotMapping: vi.fn(),
  // Real signature: (userId, meetingUrl, joinAt?).
  defaultDedupKey: (userId: string, url: string, joinAt?: string) =>
    `${userId}:${joinAt ?? "adhoc"}-${url}`,
}));
vi.mock("@/server/recall/summarize", () => ({ summarizeMeeting: vi.fn() }));
vi.mock("@/server/recall/meeting-repository", () => ({
  listMeetingRecordsForUser: vi.fn(),
  searchMeetingRecords: vi.fn(),
  findMeetingRecord: vi.fn(),
  listDynamicsForUser: vi.fn(),
}));
vi.mock("@/server/recall/dynamics-trends", () => ({ computeTeamTrends: vi.fn() }));
vi.mock("@/server/recall/recordings", () => ({
  pickRecording: vi.fn(),
  wrapUntrustedTranscript: vi.fn(),
}));
vi.mock("@/server/recall/ownership", () => ({
  isBotOwner: (...a: unknown[]) => isBotOwner(...a),
  assertBotOwner: (...a: unknown[]) => assertBotOwner(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (_u: string, fn: () => unknown) => fn(),
}));

type ToolExec = (input: unknown) => Promise<unknown>;
async function tool(name: string): Promise<ToolExec> {
  const mod = (await import("@/mastra/tools/recall.tool")) as unknown as Record<
    string,
    { execute: ToolExec }
  >;
  return mod[name].execute;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  getOrCreateBotMapping.mockImplementation(async (input) => {
    const existing = await findBotByDedupKey(input.dedupKey);
    if (existing) return { row: existing, created: false };
    const bot = await input.createBot();
    await saveBotMapping({ ...input, botId: bot.id, createBot: undefined });
    return {
      row: {
        botId: bot.id,
        dedupKey: input.dedupKey,
        meetingUrl: input.meetingUrl,
        joinAt: input.joinAt ?? null,
        metadata: input.metadata,
      },
      created: true,
    };
  });
});

describe("scheduleRecallBotTool — #3 dedup namespaced by tenant", () => {
  it("refuses to schedule without an authenticated user", async () => {
    getSession.mockResolvedValue(null);
    const exec = await tool("scheduleRecallBotTool");
    await expect(
      exec({ meetingUrl: "https://meet/x" }),
    ).rejects.toThrow(/authenticated/i);
    // No dedup lookup, no bot creation.
    expect(findBotByDedupKey).not.toHaveBeenCalled();
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("derives the dedup key from the session user (prefix u1:)", async () => {
    findBotByDedupKey.mockResolvedValue(null);
    recallFetch.mockResolvedValue({ id: "bot-new" });
    const exec = await tool("scheduleRecallBotTool");

    const res = (await exec({
      meetingUrl: "https://meet/x",
      joinAt: "2026-07-11T10:00:00Z",
    })) as { dedupKey: string; reused: boolean };

    expect(res.dedupKey).toBe("u1:2026-07-11T10:00:00Z-https://meet/x");
    // The dedup lookup used the namespaced key, and the mapping was saved with it.
    expect(findBotByDedupKey).toHaveBeenCalledWith(
      "u1:2026-07-11T10:00:00Z-https://meet/x",
    );
    expect(saveBotMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "u1:2026-07-11T10:00:00Z-https://meet/x",
        metadata: { user_id: "u1" },
      }),
    );
  });

  it("two different users get DIFFERENT dedup keys for the same meeting (no collision)", async () => {
    findBotByDedupKey.mockResolvedValue(null);
    recallFetch.mockResolvedValue({ id: "bot" });
    const exec = await tool("scheduleRecallBotTool");

    getSession.mockResolvedValue({ user: { id: "userA" } });
    const a = (await exec({ meetingUrl: "https://meet/same" })) as {
      dedupKey: string;
    };
    getSession.mockResolvedValue({ user: { id: "userB" } });
    const b = (await exec({ meetingUrl: "https://meet/same" })) as {
      dedupKey: string;
    };

    expect(a.dedupKey).not.toBe(b.dedupKey);
    expect(a.dedupKey.startsWith("userA:")).toBe(true);
    expect(b.dedupKey.startsWith("userB:")).toBe(true);
  });
});

describe("listScheduledRecallBotsTool — #2 filters to the caller's own bots", () => {
  it("refuses an unauthenticated caller", async () => {
    getSession.mockResolvedValue(null);
    const exec = await tool("listScheduledRecallBotsTool");
    await expect(exec({})).rejects.toThrow(/authenticated/i);
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("returns only bots the caller owns, not every tenant's", async () => {
    // Workspace-wide list: 3 bots, only bot-2 belongs to the caller.
    recallFetch.mockResolvedValue({
      count: 3,
      results: [
        { id: "bot-1", join_at: "t", status_changes: [] },
        { id: "bot-2", join_at: "t", status_changes: [] },
        { id: "bot-3", join_at: "t", status_changes: [] },
      ],
    });
    isBotOwner.mockImplementation(async (botId: string) => botId === "bot-2");
    const exec = await tool("listScheduledRecallBotsTool");

    const res = (await exec({})) as {
      count: number;
      bots: Array<{ botId: string }>;
    };

    expect(res.count).toBe(1);
    expect(res.bots.map((b) => b.botId)).toEqual(["bot-2"]);
    // Ownership was checked against the session user for every returned bot.
    expect(isBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    expect(isBotOwner).toHaveBeenCalledWith("bot-2", "u1");
    expect(isBotOwner).toHaveBeenCalledWith("bot-3", "u1");
  });

  it("returns an empty list when the caller owns none of the workspace bots", async () => {
    recallFetch.mockResolvedValue({
      count: 2,
      results: [
        { id: "bot-1", join_at: "t", status_changes: [] },
        { id: "bot-2", join_at: "t", status_changes: [] },
      ],
    });
    isBotOwner.mockResolvedValue(false);
    const exec = await tool("listScheduledRecallBotsTool");

    const res = (await exec({})) as { count: number; bots: unknown[] };

    expect(res.count).toBe(0);
    expect(res.bots).toEqual([]);
  });
});
