import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * proxyMediaStream — same-origin media proxy transport. Contract:
 *  - forwards the client's `Range` header upstream (byte-range streaming);
 *  - resolves the persisted URL to a server-reachable, authenticated (presigned)
 *    URL (via presignServerReachableUrl) before fetching;
 *  - mirrors the upstream status (206 vs 200) and the whitelisted response
 *    headers, and never lets a shared cache hold the media;
 *  - returns 502 when the upstream fails (source error, not client's fault).
 *
 * presignServerReachableUrl is mocked to a deterministic remap; `fetch` is stubbed.
 */

const presignServerReachableUrl = vi.fn(async (url: string) =>
  url.replace("http://localhost:9200", "http://minio:9000"),
);

vi.mock("@/server/storage/s3", () => ({
  presignServerReachableUrl: (url: string) => presignServerReachableUrl(url),
}));

async function load() {
  return import("@/server/storage/proxy");
}

const PUBLIC_URL = "http://localhost:9200/casper-uploads/uploads/u/x.mp4";
const INTERNAL_URL = "http://minio:9000/casper-uploads/uploads/u/x.mp4";

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("http://app.local/api/meetings/bot-1/video", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxyMediaStream", () => {
  it("remaps the URL and forwards a full-body 200 with mirrored headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("video-bytes", {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "11",
          "accept-ranges": "bytes",
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { proxyMediaStream } = await load();
    const res = await proxyMediaStream(PUBLIC_URL, reqWith());

    // Fetched the INTERNAL (server-reachable) URL, not the public one.
    expect(presignServerReachableUrl).toHaveBeenCalledWith(PUBLIC_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(INTERNAL_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    // Media is user-scoped: never cached by a shared cache.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("video-bytes");
  });

  it("forwards the Range header upstream and preserves a 206 partial response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("partial", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 0-6/100",
          "accept-ranges": "bytes",
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { proxyMediaStream } = await load();
    const res = await proxyMediaStream(
      PUBLIC_URL,
      reqWith({ range: "bytes=0-6" }),
    );

    // The client's Range must reach upstream (mediabunny byte-range streaming).
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).range).toBe("bytes=0-6");
    expect(init.cache).toBe("no-store");

    // 206 preserved so the seek bar / mediabunny behave.
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-6/100");
  });

  it("does not send a Range header upstream when the client didn't ask for one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("full", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { proxyMediaStream } = await load();
    await proxyMediaStream(PUBLIC_URL, reqWith());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  it("returns 502 when the upstream fetch rejects", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const { proxyMediaStream } = await load();
    const res = await proxyMediaStream(PUBLIC_URL, reqWith());
    expect(res.status).toBe(502);
  });

  it("returns 502 when the upstream responds non-ok (e.g. 404 from storage)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 404 }),
      ) as unknown as typeof fetch;

    const { proxyMediaStream } = await load();
    const res = await proxyMediaStream(PUBLIC_URL, reqWith());
    expect(res.status).toBe(502);
  });
});
