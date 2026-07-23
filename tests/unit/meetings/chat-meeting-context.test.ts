import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/chat — meeting-context injection. The notebook sends meetingBotId so
 * the agent knows which meeting is open. Security contract:
 *  - context is injected via the `system` param (a plain string appended to the
 *    agent's instructions) ONLY if the caller OWNS the bot — a forged/unowned
 *    meetingBotId is silently dropped, never reaching the agent (can't point it
 *    at another tenant's meeting). It is NOT prepended to `messages`: a system
 *    entry shaped as a UIMessage fails Mastra's CoreMessage conversion and 500s.
 *  - no session → 401, no agent call;
 *  - no meetingBotId → no `system`, messages pass through untouched.
 *
 * handleChatStream/isBotOwner/session are mocked; we assert the `system` and
 * `messages` handed to the stream handler.
 */

const getSession = vi.fn();
const isBotOwner = vi.fn();
const handleChatStream = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/ownership", () => ({
  isBotOwner: (...a: unknown[]) => isBotOwner(...a),
}));
// Rate limiter is DB-backed (Postgres); stub the check so the route never
// touches the DB. Keep the real 429 response (pure, no DB).
vi.mock("@/shared/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ ok: true, count: 1, retryAfter: 0 })),
}));
vi.mock("@mastra/ai-sdk", () => ({
  handleChatStream: (...a: unknown[]) => handleChatStream(...a),
}));
vi.mock("ai", () => ({
  createUIMessageStreamResponse: () => new Response("ok"),
  jsonSchema: (s: unknown) => s,
  tool: (t: unknown) => t,
  stepCountIs: (n: number) => n,
}));
// The agent barrel is dynamically imported inside POST — stub it away.
vi.mock("@/mastra", () => ({ mastra: {} }));
// POST awaits the store's one-time schema init, the vector-index pre-creation,
// and the per-user resource pre-create before touching memory — stub all three so
// the route never reaches Postgres.
vi.mock("@/mastra/storage", () => ({
  ensureMastraStoreInit: vi.fn(async () => {}),
  ensureMastraVectorIndex: vi.fn(async () => {}),
  ensureMastraResource: vi.fn(async () => {}),
}));

type ParamsMessages = { messages?: Array<{ role: string }> };
function messagesPassedToHandler(): Array<{ role: string }> | undefined {
  const call = handleChatStream.mock.calls[0]?.[0] as {
    params: ParamsMessages;
  };
  return call?.params?.messages;
}

function agentIdPassedToHandler(): string | undefined {
  const call = handleChatStream.mock.calls[0]?.[0] as { agentId?: string };
  return call?.agentId;
}

function systemPassedToHandler(): string | undefined {
  const call = handleChatStream.mock.calls[0]?.[0] as {
    params: { system?: string };
  };
  return call?.params?.system;
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/chat/route");
  return POST(new Request("http://x/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

const userMsg = { role: "user", parts: [{ type: "text", text: "summarize this" }] };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  // handleChatStream returns a UIMessage ReadableStream — the route tee()s it
  // (client branch + detached server drain), so the mock must be a real
  // ReadableStream, not a bare object. An immediately-closing stream is enough.
  handleChatStream.mockResolvedValue(
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  );
});

describe("POST /api/chat — meeting context", () => {
  it("owner: pins the botId via the `system` param, messages untouched", async () => {
    isBotOwner.mockResolvedValue(true);
    await post({ meetingBotId: "bot-1", messages: [userMsg] });

    expect(isBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    // Context rides on `system` (a plain string), NOT inside `messages`.
    const system = systemPassedToHandler();
    expect(typeof system).toBe("string");
    expect(system).toContain("bot-1");
    // messages carries ONLY the user turn — no system UIMessage prepended.
    const msgs = messagesPassedToHandler();
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0].role).toBe("user");
  });

  it("non-owner: drops meetingBotId, no `system` injected", async () => {
    isBotOwner.mockResolvedValue(false);
    await post({ meetingBotId: "someone-elses", messages: [userMsg] });

    expect(systemPassedToHandler()).toBeUndefined();
    const msgs = messagesPassedToHandler();
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0].role).toBe("user");
  });

  it("no meetingBotId: no `system`, messages pass through, ownership not checked", async () => {
    await post({ messages: [userMsg] });

    expect(isBotOwner).not.toHaveBeenCalled();
    expect(systemPassedToHandler()).toBeUndefined();
    const msgs = messagesPassedToHandler();
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0].role).toBe("user");
  });

  it("no session → 401, agent never called", async () => {
    getSession.mockResolvedValue(null);
    const res = await post({ meetingBotId: "bot-1", messages: [userMsg] });

    expect(res.status).toBe(401);
    expect(handleChatStream).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — agent selection (allowlist)", () => {
  it("defaults to assistantAgent when agentId is absent", async () => {
    await post({ messages: [userMsg] });
    expect(agentIdPassedToHandler()).toBe("assistantAgent");
  });

  it("routes to minutesAgent when requested (notebook path)", async () => {
    isBotOwner.mockResolvedValue(true);
    await post({
      agentId: "minutesAgent",
      meetingBotId: "bot-1",
      threadId: "meeting-bot-1",
      messages: [userMsg],
    });
    expect(agentIdPassedToHandler()).toBe("minutesAgent");
  });

  it("falls back to assistantAgent for an unknown/forged agentId", async () => {
    await post({ agentId: "searchAgent", messages: [userMsg] });
    // searchAgent is a real sub-agent but NOT in the allowlist — must not be
    // reachable directly from the client.
    expect(agentIdPassedToHandler()).toBe("assistantAgent");
  });

  it("falls back to assistantAgent for a garbage agentId", async () => {
    await post({ agentId: "../../etc/passwd", messages: [userMsg] });
    expect(agentIdPassedToHandler()).toBe("assistantAgent");
  });
});
