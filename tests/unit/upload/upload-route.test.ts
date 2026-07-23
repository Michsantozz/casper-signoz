import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Upload route (app/api/upload/route.ts). Security + validation gate before any
 * storage write:
 *
 *  1. Unauthenticated → 401, no upload.
 *  2. Missing/invalid file → 400.
 *  3. Disallowed content type → 415 (only image/* + pdf reach the vision model).
 *  4. Oversized file → 413.
 *  5. Happy path → 200 with { url, key, contentType }, key namespaced by the
 *     SESSION user (never trusted from the body).
 *  6. Storage failure → 500 (no leak of internals).
 *
 * We mock session + the storage helper (server-only, would touch S3).
 */

const getSession = vi.fn();
vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));

const uploadObject = vi.fn();
// Private bucket (audit fix #3): the route hands back a short-lived presigned
// GET, not the permanent public URL. Mock both.
const presignGetUrl = vi.fn();
vi.mock("@/server/storage/s3", () => ({
  uploadObject: (...a: unknown[]) => uploadObject(...a),
  presignGetUrl: (...a: unknown[]) => presignGetUrl(...a),
}));

// Rate limiter is DB-backed (Postgres); stub the check so the route never
// touches the DB. Keep the real 429 response (pure, no DB).
vi.mock("@/shared/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ ok: true, count: 1, retryAfter: 0 })),
}));

function makeRequest(file: File | null): Request {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("http://localhost/api/upload", {
    method: "POST",
    body: form,
  });
}

function fileOf(bytes: number, type: string, name = "photo.png"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  uploadObject.mockReset();
  presignGetUrl.mockReset();
  presignGetUrl.mockResolvedValue("http://localhost:9200/presigned?sig=abc");
});

describe("POST /api/upload", () => {
  it("returns 401 when unauthenticated (no upload)", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(makeRequest(fileOf(10, "image/png")));
    expect(res.status).toBe(401);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is present", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(makeRequest(null));
    expect(res.status).toBe(400);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("returns 415 for an unsupported content type", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(
      makeRequest(fileOf(10, "application/zip", "x.zip")),
    );
    expect(res.status).toBe(415);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("returns 413 for an oversized file", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(
      makeRequest(fileOf(11 * 1024 * 1024, "image/png")),
    );
    expect(res.status).toBe(413);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("uploads with the SESSION user id and returns the object", async () => {
    getSession.mockResolvedValue({ user: { id: "session-user" } });
    uploadObject.mockResolvedValue({
      url: "http://localhost:9200/casper-uploads/uploads/session-user/k.png",
      key: "uploads/session-user/k.png",
      contentType: "image/png",
    });
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(makeRequest(fileOf(10, "image/png", "p.png")));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; key: string };
    expect(json.key).toBe("uploads/session-user/k.png");
    // The returned URL is the presigned one (private bucket), not the raw public
    // URL from uploadObject.
    expect(json.url).toBe("http://localhost:9200/presigned?sig=abc");
    expect(presignGetUrl).toHaveBeenCalledWith("uploads/session-user/k.png");

    expect(uploadObject).toHaveBeenCalledTimes(1);
    const arg = uploadObject.mock.calls[0][0] as { userId: string };
    // userId comes from the session, not from the request body.
    expect(arg.userId).toBe("session-user");
  });

  it("returns 500 when storage fails", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" } });
    uploadObject.mockRejectedValue(new Error("s3 down"));
    const { POST } = await import("@/app/api/upload/route");
    const res = await POST(makeRequest(fileOf(10, "image/png")));
    expect(res.status).toBe(500);
  });
});
