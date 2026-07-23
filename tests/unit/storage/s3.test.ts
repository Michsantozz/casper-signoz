import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Object storage helper (server/storage/s3.ts). Guarantees:
 *
 *  1. uploadObject sends a PutObjectCommand to the configured bucket with the
 *     bytes + content type, and returns the PUBLIC url (S3_PUBLIC_URL + key).
 *  2. The object key is namespaced by userId and carries a sane extension
 *     (from filename, else from mime) — never a client-controlled path.
 *  3. Missing config fails loudly (no silent upload to nowhere).
 *
 * We mock `@aws-sdk/client-s3` (no network) and `uuid` (deterministic key).
 */

const send = vi.fn();
class FakePutObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = (...a: unknown[]) => send(...a);
  },
  PutObjectCommand: FakePutObjectCommand,
}));
vi.mock("uuid", () => ({ v4: () => "fixed-uuid" }));

const ORIGINAL = { ...process.env };

function setEnv() {
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ENDPOINT = "http://minio:9000";
  process.env.S3_BUCKET = "casper-uploads";
  process.env.S3_ACCESS_KEY_ID = "key";
  process.env.S3_SECRET_ACCESS_KEY = "secret";
  process.env.S3_PUBLIC_URL = "http://localhost:9200/casper-uploads";
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

describe("uploadObject", () => {
  it("puts bytes to the bucket and returns the public URL", async () => {
    const { uploadObject } = await import("@/server/storage/s3");
    const body = Buffer.from("img-bytes");

    const result = await uploadObject({
      userId: "user-1",
      filename: "photo.png",
      contentType: "image/png",
      body,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0] as FakePutObjectCommand;
    expect(cmd).toBeInstanceOf(FakePutObjectCommand);
    expect(cmd.input.Bucket).toBe("casper-uploads");
    expect(cmd.input.ContentType).toBe("image/png");
    expect(cmd.input.Body).toBe(body);

    // key: uploads/<userId>/<uuid>.<ext>
    expect(cmd.input.Key).toBe("uploads/user-1/fixed-uuid.png");
    expect(result.key).toBe("uploads/user-1/fixed-uuid.png");
    expect(result.url).toBe(
      "http://localhost:9200/casper-uploads/uploads/user-1/fixed-uuid.png",
    );
    expect(result.contentType).toBe("image/png");
  });

  it("namespaces the key by userId (no cross-user path)", async () => {
    const { uploadObject } = await import("@/server/storage/s3");
    await uploadObject({
      userId: "other-user",
      filename: "x.jpg",
      contentType: "image/jpeg",
      body: Buffer.from("z"),
    });
    const cmd = send.mock.calls[0][0] as FakePutObjectCommand;
    expect(cmd.input.Key).toBe("uploads/other-user/fixed-uuid.jpg");
  });

  it("derives extension from mime when filename has none", async () => {
    const { uploadObject } = await import("@/server/storage/s3");
    await uploadObject({
      userId: "u",
      filename: "noext",
      contentType: "image/webp",
      body: Buffer.from("z"),
    });
    const cmd = send.mock.calls[0][0] as FakePutObjectCommand;
    expect(cmd.input.Key).toBe("uploads/u/fixed-uuid.webp");
  });

  it("falls back to derived public base from endpoint+bucket when S3_PUBLIC_URL is unset", async () => {
    delete process.env.S3_PUBLIC_URL;
    const { uploadObject } = await import("@/server/storage/s3");
    const result = await uploadObject({
      userId: "u",
      filename: "a.png",
      contentType: "image/png",
      body: Buffer.from("z"),
    });
    expect(result.url).toBe(
      "http://minio:9000/casper-uploads/uploads/u/fixed-uuid.png",
    );
  });

  it("throws when credentials are missing (fail loud, no silent upload)", async () => {
    delete process.env.S3_ACCESS_KEY_ID;
    const { uploadObject } = await import("@/server/storage/s3");
    await expect(
      uploadObject({
        userId: "u",
        filename: "a.png",
        contentType: "image/png",
        body: Buffer.from("z"),
      }),
    ).rejects.toThrow(/Storage not configured/);
    expect(send).not.toHaveBeenCalled();
  });

  it("throws when bucket is missing", async () => {
    delete process.env.S3_BUCKET;
    const { uploadObject } = await import("@/server/storage/s3");
    await expect(
      uploadObject({
        userId: "u",
        filename: "a.png",
        contentType: "image/png",
        body: Buffer.from("z"),
      }),
    ).rejects.toThrow(/Storage not configured/);
  });
});

/**
 * toServerReachableUrl — remaps a persisted PUBLIC object URL (host-facing, e.g.
 * localhost:9200) to the INTERNAL endpoint (minio:9000) so the same-origin media
 * proxy can fetch it from inside the container. URLs that don't share our public
 * base (Recall's signed CDN URLs) must pass through untouched.
 */
describe("toServerReachableUrl", () => {
  it("swaps the public base for the internal endpoint base", async () => {
    const { toServerReachableUrl } = await import("@/server/storage/s3");
    expect(
      toServerReachableUrl(
        "http://localhost:9200/casper-uploads/uploads/u/x.mp4",
      ),
    ).toBe("http://minio:9000/casper-uploads/uploads/u/x.mp4");
  });

  it("leaves a Recall signed URL (different origin) untouched", async () => {
    const { toServerReachableUrl } = await import("@/server/storage/s3");
    const recall = "https://recall-cdn.example.com/signed.mp4?token=abc";
    expect(toServerReachableUrl(recall)).toBe(recall);
  });

  it("passes the URL through when no S3_ENDPOINT is set (real AWS S3)", async () => {
    // Real AWS: the public URL is already server-reachable, no remap needed.
    delete process.env.S3_ENDPOINT;
    const { toServerReachableUrl } = await import("@/server/storage/s3");
    const url = "http://localhost:9200/casper-uploads/uploads/u/x.mp4";
    expect(toServerReachableUrl(url)).toBe(url);
  });

  it("passes the URL through when S3_PUBLIC_URL is unset", async () => {
    delete process.env.S3_PUBLIC_URL;
    const { toServerReachableUrl } = await import("@/server/storage/s3");
    const url = "http://minio:9000/casper-uploads/uploads/u/x.mp4";
    expect(toServerReachableUrl(url)).toBe(url);
  });

  it("tolerates a trailing slash on the public base", async () => {
    process.env.S3_PUBLIC_URL = "http://localhost:9200/casper-uploads/";
    const { toServerReachableUrl } = await import("@/server/storage/s3");
    expect(
      toServerReachableUrl(
        "http://localhost:9200/casper-uploads/uploads/u/x.mp4",
      ),
    ).toBe("http://minio:9000/casper-uploads/uploads/u/x.mp4");
  });
});
