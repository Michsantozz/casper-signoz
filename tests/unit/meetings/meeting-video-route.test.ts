import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GET /api/meetings/:botId/video — same-origin media proxy (owner view).
 * Contract:
 *  - no session → 401, no detail read (fail-closed);
 *  - session → resolves the meeting UNDER withUserScope(userId) (RLS);
 *  - no record OR no captured video → 404 (doesn't leak another user's meeting);
 *  - otherwise streams the raw videoUrl through proxyMediaStream(url, req),
 *    forwarding the request so Range/status pass through.
 *
 * Server-only libs (session, RLS, detail, proxy) are mocked to isolate the route.
 */

const getSession = vi.fn();
const getMeetingDetail = vi.fn();
const proxyMediaStream = vi.fn();
const withUserScope = vi.fn((_userId: string, fn: () => unknown) => fn());

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/meeting-detail", () => ({
  getMeetingDetail: (...a: unknown[]) => getMeetingDetail(...a),
}));
vi.mock("@/server/storage/proxy", () => ({
  proxyMediaStream: (...a: unknown[]) => proxyMediaStream(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (userId: string, fn: () => unknown) =>
    withUserScope(userId, fn),
}));

function req(): Request {
  return new Request("http://x/api/meetings/bot-1/video", {
    headers: { range: "bytes=0-99" },
  });
}
async function call(): Promise<Response> {
  const { GET } = await import("@/app/api/meetings/[botId]/video/route");
  return GET(req(), { params: Promise.resolve({ botId: "bot-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  proxyMediaStream.mockResolvedValue(new Response("bytes", { status: 206 }));
});

describe("GET /api/meetings/:botId/video — auth gate", () => {
  it("no session → 401 and no detail read", async () => {
    getSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(getMeetingDetail).not.toHaveBeenCalled();
    expect(withUserScope).not.toHaveBeenCalled();
    expect(proxyMediaStream).not.toHaveBeenCalled();
  });

  it("session without user.id → 401", async () => {
    getSession.mockResolvedValue({ user: {} });
    const res = await call();
    expect(res.status).toBe(401);
    expect(getMeetingDetail).not.toHaveBeenCalled();
  });
});

describe("GET /api/meetings/:botId/video — 404s (no leak)", () => {
  it("no record for the user → 404", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    getMeetingDetail.mockResolvedValue({ record: null, videoUrl: null });
    const res = await call();
    expect(res.status).toBe(404);
    expect(proxyMediaStream).not.toHaveBeenCalled();
  });

  it("record but no captured video → 404", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    getMeetingDetail.mockResolvedValue({ record: { botId: "bot-1" }, videoUrl: null });
    const res = await call();
    expect(res.status).toBe(404);
    expect(proxyMediaStream).not.toHaveBeenCalled();
  });
});

describe("GET /api/meetings/:botId/video — scoped stream", () => {
  it("resolves under withUserScope and streams the raw videoUrl", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    getMeetingDetail.mockResolvedValue({
      record: { botId: "bot-1" },
      videoUrl: "http://localhost:9200/casper-uploads/uploads/u1/x.mp4",
    });

    const res = await call();

    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    // The RAW url (not the proxy path) is what gets streamed upstream.
    expect(proxyMediaStream).toHaveBeenCalledWith(
      "http://localhost:9200/casper-uploads/uploads/u1/x.mp4",
      expect.any(Request),
    );
    expect(res.status).toBe(206);
  });
});
