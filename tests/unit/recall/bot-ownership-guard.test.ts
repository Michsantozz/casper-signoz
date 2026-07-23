import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * By-botId Recall tools MUST refuse a bot the caller doesn't own, BEFORE any
 * Recall fetch. Regression guard for the cross-tenant leak: a logged-in user
 * passing someone else's botId to get_transcript / get_recording / etc. must be
 * blocked, and the Recall API must never be called for a denied bot.
 *
 * We mock the ownership resolver and recallFetch, then drive a representative
 * read tool (get_recall_transcript) and a write tool (cancel_recall_bot).
 */

const getSession = vi.fn();
const assertBotOwner = vi.fn();
const recallFetch = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/ownership", () => ({
  assertBotOwner: (...a: unknown[]) => assertBotOwner(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
  RecallAdhocPoolError: class extends Error {},
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByDedupKey: vi.fn(),
  saveBotMapping: vi.fn(),
  deleteBotMapping: vi.fn(),
  defaultDedupKey: vi.fn(),
}));
vi.mock("@/server/recall/summarize", () => ({ summarizeMeeting: vi.fn() }));
vi.mock("@/server/recall/meeting-repository", () => ({
  listMeetingRecordsForUser: vi.fn(),
  searchMeetingRecords: vi.fn(),
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
});

describe("by-botId tools — ownership guard", () => {
  it("read tool: denied bot throws and never calls Recall", async () => {
    assertBotOwner.mockRejectedValue(new Error("not found or not accessible"));
    const exec = await tool("getRecallTranscriptTool");

    await expect(exec({ botId: "someone-elses" })).rejects.toThrow(
      /not found or not accessible/i,
    );
    expect(assertBotOwner).toHaveBeenCalledWith("someone-elses", "u1");
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("read tool: no session → throws before ownership check and before Recall", async () => {
    getSession.mockResolvedValue(null);
    const exec = await tool("getRecallTranscriptTool");

    await expect(exec({ botId: "bot-1" })).rejects.toThrow(
      /not authenticated/i,
    );
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("write tool: cancel denied bot throws and never calls Recall", async () => {
    assertBotOwner.mockRejectedValue(new Error("not found or not accessible"));
    const exec = await tool("cancelRecallBotTool");

    await expect(exec({ botId: "someone-elses" })).rejects.toThrow(
      /not found or not accessible/i,
    );
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("owner passes the guard and proceeds to Recall", async () => {
    assertBotOwner.mockResolvedValue(undefined);
    recallFetch.mockResolvedValue({ ok: true });
    const exec = await tool("getRecallBotTool");

    await exec({ botId: "bot-1" });
    expect(assertBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    expect(recallFetch).toHaveBeenCalled();
  });
});
