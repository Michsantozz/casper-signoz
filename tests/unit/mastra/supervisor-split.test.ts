import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Supervisor split (mastra/agents/*.agent.ts). The assistantAgent is a
 * SUPERVISOR that delegates two domains to sub-agents:
 *  - minutesAgent  → per-meeting minutes (summarize/transcript/participants/recording)
 *  - searchAgent   → cross-meeting history (list/search)
 *
 * Contract we assert (statically, no LLM):
 *  - both sub-agents are registered on the supervisor's `agents` field;
 *  - each sub-agent owns exactly its domain tools and NO others;
 *  - the moved tools (minutes/search) are NOT on the supervisor anymore — they
 *    live only in the sub-agents;
 *  - the supervisor keeps its own scheduling/calendar/bot-control tools;
 *  - every sub-agent has a description (drives the auto-generated delegation tool).
 *
 * The MCP client is mocked so the supervisor's dynamic `tools` resolver (which
 * merges local + MCP tools) doesn't hit the network.
 */

vi.mock("@/mastra/mcp", () => ({
  mcp: {
    listToolsetsWithErrors: vi.fn(async () => ({ toolsets: {}, errors: {} })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIREWORKS_API_KEY = "fw-test";
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
});

async function toolNames(agent: {
  listTools: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}) {
  return Object.keys(await agent.listTools());
}

describe("minutesAgent — minutes specialist", () => {
  // The first import here pulls in the Mastra agent graph (cold), which is slow;
  // subsequent tests reuse it. Give the first assertion a wider window.
  it("owns exactly the per-meeting minutes tools", async () => {
    const { minutesAgent } = await import("@/mastra/agents/minutes.agent");
    expect((await toolNames(minutesAgent)).sort()).toEqual(
      [
        "get_meeting_dynamics",
        "get_participants",
        "get_recording",
        "get_transcript",
        "summarize_meeting",
      ].sort(),
    );
  }, 20_000);

  it("has an id and a description for delegation", async () => {
    const { minutesAgent } = await import("@/mastra/agents/minutes.agent");
    expect(minutesAgent.id).toBe("minutesAgent");
    expect(minutesAgent.getDescription().length).toBeGreaterThan(0);
  });

  it("has NO scheduling/search/client tools", async () => {
    const { minutesAgent } = await import("@/mastra/agents/minutes.agent");
    const names = await toolNames(minutesAgent);
    for (const forbidden of [
      "create_calendar_event",
      "send_bot_to_meeting",
      "search_my_meetings",
      "pick_date",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("searchAgent — cross-meeting search specialist", () => {
  it("owns exactly the history-search tools", async () => {
    const { searchAgent } = await import("@/mastra/agents/search.agent");
    expect((await toolNames(searchAgent)).sort()).toEqual(
      ["get_team_trends", "list_my_meetings", "search_my_meetings"].sort(),
    );
  });

  it("has an id and a description for delegation", async () => {
    const { searchAgent } = await import("@/mastra/agents/search.agent");
    expect(searchAgent.id).toBe("searchAgent");
    expect(searchAgent.getDescription().length).toBeGreaterThan(0);
  });
});

describe("assistantAgent — supervisor", () => {
  it("registers both sub-agents on its `agents` field", async () => {
    const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
    const sub = assistantAgent.__getStaticAgents() ?? {};
    expect(Object.keys(sub).sort()).toEqual(["minutesAgent", "searchAgent"]);
  });

  it("keeps its own scheduling / calendar / bot-control tools", async () => {
    const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
    const names = await toolNames(assistantAgent);
    for (const own of [
      "create_calendar_event",
      "list_calendar_events",
      "get_free_slots",
      "send_bot_to_meeting",
      "start_recording",
      "stop_recording",
      "remove_bot",
    ]) {
      expect(names).toContain(own);
    }
  });

  it("no longer carries the delegated (minutes/search) tools", async () => {
    const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
    const names = await toolNames(assistantAgent);
    for (const moved of [
      "summarize_meeting",
      "get_transcript",
      "get_participants",
      "get_recording",
      "list_my_meetings",
      "search_my_meetings",
    ]) {
      expect(names).not.toContain(moved);
    }
  });
});
