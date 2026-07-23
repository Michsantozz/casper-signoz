import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * GET /api/public/meetings/:token/video — same-origin media proxy (public view).
 * Contract:
 *  - authorization IS the share token (no session check);
 *  - unknown/revoked token → 404 (no leak);
 *  - a shared meeting with no durable video → 404;
 *  - otherwise streams the durable videoUrl through proxyMediaStream(url, req).
 *
 * getPublicMeeting + proxy are mocked to isolate the route.
 */

const getPublicMeeting = vi.fn();
const proxyMediaStream = vi.fn();

vi.mock("@/server/recall/public-meeting", () => ({
  getPublicMeeting: (...a: unknown[]) => getPublicMeeting(...a),
}));
vi.mock("@/server/storage/proxy", () => ({
  proxyMediaStream: (...a: unknown[]) => proxyMediaStream(...a),
}));

function req(): Request {
  return new Request("http://x/api/public/meetings/tok-1/video");
}
async function call(): Promise<Response> {
  const { GET } = await import("@/app/api/public/meetings/[token]/video/route");
  return GET(req(), { params: Promise.resolve({ token: "tok-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  proxyMediaStream.mockResolvedValue(new Response("bytes", { status: 200 }));
});

describe("GET /api/public/meetings/:token/video", () => {
  it("unknown/revoked token → 404 and no stream", async () => {
    getPublicMeeting.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(proxyMediaStream).not.toHaveBeenCalled();
  });

  it("shared meeting with no durable video → 404", async () => {
    getPublicMeeting.mockResolvedValue({ videoUrl: null });
    const res = await call();
    expect(res.status).toBe(404);
    expect(proxyMediaStream).not.toHaveBeenCalled();
  });

  it("streams the durable videoUrl through the proxy", async () => {
    getPublicMeeting.mockResolvedValue({
      videoUrl: "http://localhost:9200/casper-uploads/uploads/_shared/x.mp4",
    });

    const res = await call();

    expect(getPublicMeeting).toHaveBeenCalledWith("tok-1");
    expect(proxyMediaStream).toHaveBeenCalledWith(
      "http://localhost:9200/casper-uploads/uploads/_shared/x.mp4",
      expect.any(Request),
    );
    expect(res.status).toBe(200);
  });
});
