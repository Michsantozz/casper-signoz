import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Chat-thread route handlers (threads, thread-item, thread-messages) — the CRUD
 * surface behind the ThreadList sidebar. Thin shells: auth gate → delegate to
 * the assistant thread store → map "thread not found" to 404. Untested until
 * now. We mock the session and the store, then drive each handler.
 */
const getSession = vi.fn();
const listThreads = vi.fn();
const createThread = vi.fn();
const renameThread = vi.fn();
const setArchived = vi.fn();
const deleteThread = vi.fn();
const getThreadMessages = vi.fn();
const generateThreadTitle = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/features/assistant/model/threads", () => ({
  listThreads: (...a: unknown[]) => listThreads(...a),
  createThread: (...a: unknown[]) => createThread(...a),
  renameThread: (...a: unknown[]) => renameThread(...a),
  setArchived: (...a: unknown[]) => setArchived(...a),
  deleteThread: (...a: unknown[]) => deleteThread(...a),
  getThreadMessages: (...a: unknown[]) => getThreadMessages(...a),
  generateThreadTitle: (...a: unknown[]) => generateThreadTitle(...a),
}));

const req = (body?: unknown) =>
  new Request("https://app.com/api/threads", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
});

describe("GET /threads", () => {
  it("401 without a session, store untouched", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/_app/api-routes/threads");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("returns the caller's threads", async () => {
    listThreads.mockResolvedValue([{ id: "t1" }]);
    const { GET } = await import("@/_app/api-routes/threads");
    const res = await GET();
    expect(await res.json()).toEqual({ threads: [{ id: "t1" }] });
    expect(listThreads).toHaveBeenCalledWith("u1");
  });
});

describe("POST /threads", () => {
  it("401 without a session", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/_app/api-routes/threads");
    expect((await POST(req({ id: "t1" }))).status).toBe(401);
  });

  it("400 when id is missing", async () => {
    const { POST } = await import("@/_app/api-routes/threads");
    const res = await POST(req({ title: "x" }));
    expect(res.status).toBe(400);
    expect(createThread).not.toHaveBeenCalled();
  });

  it("creates the thread with the session user and client id", async () => {
    createThread.mockResolvedValue({ id: "t1" });
    const { POST } = await import("@/_app/api-routes/threads");
    const res = await POST(req({ id: "t1", title: "Hi" }));
    expect(res.status).toBe(200);
    expect(createThread).toHaveBeenCalledWith("u1", "t1", "Hi");
  });

  it("409 when the client id already belongs to another user", async () => {
    createThread.mockRejectedValue(new Error("thread id conflict"));
    const { POST } = await import("@/_app/api-routes/threads");
    const res = await POST(req({ id: "foreign-thread" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "thread id conflict" });
  });
});

describe("PATCH /threads/:id", () => {
  it("401 without a session", async () => {
    getSession.mockResolvedValue(null);
    const { PATCH } = await import("@/_app/api-routes/thread-item");
    expect((await PATCH(req({ title: "x" }), ctx("t1"))).status).toBe(401);
  });

  it("renames and archives under the session user", async () => {
    const { PATCH } = await import("@/_app/api-routes/thread-item");
    const res = await PATCH(req({ title: "New", archived: true }), ctx("t1"));
    expect(res.status).toBe(200);
    expect(renameThread).toHaveBeenCalledWith("u1", "t1", "New");
    expect(setArchived).toHaveBeenCalledWith("u1", "t1", true);
  });

  it("maps 'thread not found' from the store to 404 (ownership)", async () => {
    renameThread.mockRejectedValue(new Error("thread not found"));
    const { PATCH } = await import("@/_app/api-routes/thread-item");
    const res = await PATCH(req({ title: "x" }), ctx("someone-elses"));
    expect(res.status).toBe(404);
  });

  it("re-throws unexpected errors (not swallowed as 404)", async () => {
    renameThread.mockRejectedValue(new Error("db down"));
    const { PATCH } = await import("@/_app/api-routes/thread-item");
    await expect(PATCH(req({ title: "x" }), ctx("t1"))).rejects.toThrow("db down");
  });
});

describe("DELETE /threads/:id", () => {
  it("401 without a session", async () => {
    getSession.mockResolvedValue(null);
    const { DELETE } = await import("@/_app/api-routes/thread-item");
    expect((await DELETE(req(), ctx("t1"))).status).toBe(401);
  });

  it("deletes under the session user", async () => {
    const { DELETE } = await import("@/_app/api-routes/thread-item");
    const res = await DELETE(req(), ctx("t1"));
    expect(res.status).toBe(200);
    expect(deleteThread).toHaveBeenCalledWith("u1", "t1");
  });

  it("maps a foreign thread to 404", async () => {
    deleteThread.mockRejectedValue(new Error("thread not found"));
    const { DELETE } = await import("@/_app/api-routes/thread-item");
    expect((await DELETE(req(), ctx("someone-elses"))).status).toBe(404);
  });
});

describe("POST /threads/:id/title", () => {
  it("401 without a session, store untouched", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/_app/api-routes/thread-title");
    const res = await POST(req(), ctx("t1"));
    expect(res.status).toBe(401);
    expect(generateThreadTitle).not.toHaveBeenCalled();
  });

  it("returns the generated title scoped to the session user", async () => {
    generateThreadTitle.mockResolvedValue("Weekly sync recap");
    const { POST } = await import("@/_app/api-routes/thread-title");
    const res = await POST(req(), ctx("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Weekly sync recap" });
    expect(generateThreadTitle).toHaveBeenCalledWith("u1", "t1");
  });

  it("passes through a null title (empty thread → keep fallback)", async () => {
    generateThreadTitle.mockResolvedValue(null);
    const { POST } = await import("@/_app/api-routes/thread-title");
    const res = await POST(req(), ctx("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: null });
  });

  it("maps a foreign thread to 404 (ownership)", async () => {
    generateThreadTitle.mockRejectedValue(new Error("thread not found"));
    const { POST } = await import("@/_app/api-routes/thread-title");
    expect((await POST(req(), ctx("someone-elses"))).status).toBe(404);
  });

  it("re-throws unexpected errors (not swallowed as 404)", async () => {
    generateThreadTitle.mockRejectedValue(new Error("model down"));
    const { POST } = await import("@/_app/api-routes/thread-title");
    await expect(POST(req(), ctx("t1"))).rejects.toThrow("model down");
  });
});

describe("GET /threads/:id/messages", () => {
  it("401 without a session, store untouched", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/_app/api-routes/thread-messages");
    const res = await GET(req(), ctx("t1"));
    expect(res.status).toBe(401);
    expect(getThreadMessages).not.toHaveBeenCalled();
  });

  it("returns messages scoped to the session user", async () => {
    getThreadMessages.mockResolvedValue([{ role: "user" }]);
    const { GET } = await import("@/_app/api-routes/thread-messages");
    const res = await GET(req(), ctx("t1"));
    expect(await res.json()).toEqual({ messages: [{ role: "user" }] });
    expect(getThreadMessages).toHaveBeenCalledWith("u1", "t1");
  });
});
