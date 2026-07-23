import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * deleteObjectByUrl (server/storage/s3.ts) — best-effort reclaim of durable
 * object bytes when a meeting is deleted. Guarantees:
 *
 *  1. A URL under our own S3_PUBLIC_URL is translated to its object key and a
 *     DeleteObjectCommand is issued against the configured bucket; returns true.
 *  2. A foreign-host URL (e.g. Recall's signed CDN URL) is NEVER sent to
 *     DeleteObject — must not risk deleting from someone else's bucket. Returns
 *     false without touching `send`.
 *  3. If `.send` rejects, the error is swallowed (logged) and false is returned
 *     — a storage hiccup must never block the record delete.
 *  4. When storage isn't configured (publicBase() throws), returns false
 *     without throwing.
 *
 * We mock `@aws-sdk/client-s3` (no network) and `uuid` (unused here, but s3.ts
 * imports it at module scope). `client` is cached at module scope, so we
 * vi.resetModules() + re-import per test to let env changes take effect.
 */

const send = vi.fn();
class FakeDeleteObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}
class FakePutObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = (...a: unknown[]) => send(...a);
  },
  DeleteObjectCommand: FakeDeleteObjectCommand,
  PutObjectCommand: FakePutObjectCommand,
}));
vi.mock("uuid", () => ({ v4: () => "fixed-uuid" }));

const logSpy = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock("@/shared/lib/logger", () => ({
  createLogger: () => logSpy,
  logger: logSpy,
}));

const ORIGINAL = { ...process.env };

function setEnv() {
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ENDPOINT = "http://minio:9000";
  process.env.S3_BUCKET = "casper-uploads";
  process.env.S3_ACCESS_KEY_ID = "key";
  process.env.S3_SECRET_ACCESS_KEY = "secret";
  process.env.S3_PUBLIC_URL = "https://cdn.example.com/bucket";
  process.env.S3_FORCE_PATH_STYLE = "true";
}

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  send.mockResolvedValue({});
  setEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("deleteObjectByUrl", () => {
  it("deletes the object under our public base and returns true", async () => {
    const { deleteObjectByUrl } = await import("@/server/storage/s3");

    const url = "https://cdn.example.com/bucket/uploads/user-1/video.mp4";
    const result = await deleteObjectByUrl(url);

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as FakeDeleteObjectCommand;
    expect(cmd).toBeInstanceOf(FakeDeleteObjectCommand);
    expect(cmd.input.Bucket).toBe("casper-uploads");
    expect(cmd.input.Key).toBe("uploads/user-1/video.mp4");
    expect(result).toBe(true);
  });

  it("never calls send for a foreign-host URL (e.g. Recall's signed CDN)", async () => {
    const { deleteObjectByUrl } = await import("@/server/storage/s3");

    const foreign = "https://recall-cdn.com/signed/x.mp4";
    const result = await deleteObjectByUrl(foreign);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a send() rejection and returns false (never throws)", async () => {
    send.mockRejectedValueOnce(new Error("network blip"));
    logSpy.error.mockReset();
    const { deleteObjectByUrl } = await import("@/server/storage/s3");

    const url = "https://cdn.example.com/bucket/uploads/user-1/video.mp4";
    const result = await deleteObjectByUrl(url);

    expect(result).toBe(false);
    expect(logSpy.error).toHaveBeenCalled();
  });

  it("returns false without throwing when storage isn't configured", async () => {
    delete process.env.S3_PUBLIC_URL;
    delete process.env.S3_ENDPOINT;
    const { deleteObjectByUrl } = await import("@/server/storage/s3");

    const url = "https://cdn.example.com/bucket/uploads/user-1/video.mp4";
    await expect(deleteObjectByUrl(url)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
