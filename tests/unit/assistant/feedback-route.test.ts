import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/feedback — human 👍/👎 into Mastra's observability feedback pipeline.
 * Contract:
 *  - no session → 401, no addFeedback call (fail-closed);
 *  - invalid type (not positive|negative) → 400, no addFeedback;
 *  - valid → addFeedback with feedbackType "thumbs", value up|down,
 *    feedbackUserId = SESSION user id (never trusted from body), and
 *    messageId/threadId carried in metadata;
 *  - addFeedback is optional on the entrypoint → called defensively (?.), so a
 *    NoOp observability must not 500.
 *
 * session + the @/mastra barrel (dynamically imported in the route) are mocked.
 */

const getSession = vi.fn();
const addFeedback = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/mastra", () => ({
  mastra: { observability: { addFeedback: (...a: unknown[]) => addFeedback(...a) } },
}));

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/feedback/route");
  return POST(
    new Request("http://x/api/feedback", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  addFeedback.mockResolvedValue(undefined);
});

describe("POST /api/feedback — auth gate", () => {
  it("no session → 401, no addFeedback", async () => {
    getSession.mockResolvedValue(null);
    const res = await post({ messageId: "m", threadId: "t", type: "positive" });
    expect(res.status).toBe(401);
    expect(addFeedback).not.toHaveBeenCalled();
  });

  it("session without user.id → 401", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await post({ type: "positive" });
    expect(res.status).toBe(401);
    expect(addFeedback).not.toHaveBeenCalled();
  });
});

describe("POST /api/feedback — validation", () => {
  it("invalid type → 400, no addFeedback", async () => {
    const res = await post({ messageId: "m", type: "meh" });
    expect(res.status).toBe(400);
    expect(addFeedback).not.toHaveBeenCalled();
  });

  it("missing type → 400", async () => {
    const res = await post({ messageId: "m" });
    expect(res.status).toBe(400);
    expect(addFeedback).not.toHaveBeenCalled();
  });
});

describe("POST /api/feedback — records thumbs feedback", () => {
  it("positive → value 'up', user id from session, ids in metadata", async () => {
    const res = await post({ messageId: "m-9", threadId: "t-3", type: "positive" });
    expect(res.status).toBe(200);
    expect(addFeedback).toHaveBeenCalledWith({
      feedback: {
        feedbackType: "thumbs",
        value: "up",
        feedbackSource: "user",
        feedbackUserId: "user-1",
        metadata: { messageId: "m-9", threadId: "t-3" },
      },
    });
  });

  it("negative → value 'down'", async () => {
    await post({ messageId: "m", threadId: "t", type: "negative" });
    const arg = addFeedback.mock.calls[0][0] as {
      feedback: { value: string };
    };
    expect(arg.feedback.value).toBe("down");
  });

  it("feedbackUserId ignores any user id supplied in the body", async () => {
    await post({ messageId: "m", type: "positive", feedbackUserId: "attacker" });
    const arg = addFeedback.mock.calls[0][0] as {
      feedback: { feedbackUserId: string };
    };
    expect(arg.feedback.feedbackUserId).toBe("user-1");
  });

  it("does not 500 when observability.addFeedback is absent (NoOp)", async () => {
    vi.doMock("@/mastra", () => ({ mastra: { observability: {} } }));
    vi.resetModules();
    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      new Request("http://x/api/feedback", {
        method: "POST",
        body: JSON.stringify({ messageId: "m", type: "positive" }),
      }),
    );
    expect(res.status).toBe(200);
    vi.doUnmock("@/mastra");
    vi.resetModules();
  });
});
