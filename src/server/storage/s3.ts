import "server-only";
import { Buffer } from "node:buffer";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("s3");

/**
 * Object storage for chat attachments (MinIO in docker-compose, any S3-compat
 * endpoint in prod). Server-only: the S3 credentials must never reach the
 * client bundle. The browser talks to `/api/upload`, never to S3 directly.
 *
 * PRIVATE bucket (see `minio-init` in docker-compose — anonymous access is
 * `none`). Objects are NOT world-readable. Two delivery paths:
 *  - meeting recordings → authenticated same-origin proxy (/api/meeting-video),
 *    session + RLS enforced; the raw URL never leaves the server.
 *  - chat image attachments → the vision provider fetches by URL, so /api/upload
 *    returns a short-lived presigned GET (presignGetUrl) instead of a permanent
 *    public URL. A leaked link expires; it doesn't grant durable access.
 */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Storage not configured: S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY missing.");
  }
  client = new S3Client({
    region: env("S3_REGION") ?? "us-east-1",
    // Omit endpoint for real AWS S3; set for MinIO/R2 (S3_ENDPOINT).
    ...(env("S3_ENDPOINT") ? { endpoint: env("S3_ENDPOINT") } : {}),
    // Path-style is required by MinIO and R2; AWS S3 uses virtual-hosted style.
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

function bucket(): string {
  const b = env("S3_BUCKET");
  if (!b) throw new Error("Storage not configured: S3_BUCKET missing.");
  return b;
}

/** Public base URL objects are served from (browser + vision model fetch here). */
function publicBase(): string {
  const explicit = env("S3_PUBLIC_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  // Fallback: derive from endpoint + bucket (path-style).
  const endpoint = env("S3_ENDPOINT");
  if (endpoint) return `${endpoint.replace(/\/$/, "")}/${bucket()}`;
  throw new Error("Storage not configured: S3_PUBLIC_URL or S3_ENDPOINT required.");
}

/**
 * Internal base URL the *server* reaches the object store at (path-style,
 * bucket included). In compose this is `http://minio:9000/<bucket>` — reachable
 * over the internal network — while the persisted public URL is
 * `http://localhost:9200/<bucket>`, which only the host/browser can resolve.
 * Returns null when no endpoint is configured (real AWS S3: public URL is
 * already server-reachable).
 */
function internalBase(): string | null {
  const endpoint = env("S3_ENDPOINT");
  if (!endpoint) return null;
  return `${endpoint.replace(/\/$/, "")}/${bucket()}`;
}

/**
 * Rewrites a persisted public object URL to one the server can fetch. A stored
 * meeting `videoUrl` is `S3_PUBLIC_URL/...` (host-facing, e.g. localhost:9200);
 * when the same-origin proxy fetches it from *inside* the container, that host
 * is unreachable, so we swap the public base for the internal endpoint base.
 * URLs that don't start with our public base (e.g. Recall's signed CDN URLs)
 * pass through untouched.
 */
export function toServerReachableUrl(url: string): string {
  const publicUrl = env("S3_PUBLIC_URL");
  const internal = internalBase();
  if (!publicUrl || !internal) return url;
  const base = publicUrl.replace(/\/$/, "");
  return url.startsWith(base) ? internal + url.slice(base.length) : url;
}

let internalPresignClient: S3Client | null = null;

/** Signing client pinned to the INTERNAL endpoint (server-reachable host). */
function getInternalPresignClient(): S3Client {
  if (internalPresignClient) return internalPresignClient;
  const endpoint = env("S3_ENDPOINT");
  if (!endpoint) return getClient();
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Storage not configured: S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY missing.");
  }
  internalPresignClient = new S3Client({
    region: env("S3_REGION") ?? "us-east-1",
    endpoint: new URL(endpoint).origin,
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
  return internalPresignClient;
}

/**
 * Turns a persisted media URL into a SERVER-reachable, AUTHENTICATED URL for the
 * proxy to fetch. The bucket is private, so an anonymous GET now 403s — the
 * proxy must present credentials. For URLs that live in our bucket we return a
 * short-lived presigned GET signed against the internal endpoint (reachable from
 * inside the container). Foreign URLs (Recall's own signed CDN links) already
 * carry their own auth and pass through untouched.
 */
export async function presignServerReachableUrl(url: string): Promise<string> {
  const key = keyFromPublicUrl(url);
  if (!key) return url; // not ours (e.g. Recall signed URL) → leave as-is
  return getSignedUrl(
    getInternalPresignClient(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

function keyFor(userId: string, filename: string, contentType: string): string {
  const dot = filename.lastIndexOf(".");
  const fromName = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const ext = fromName || EXT_BY_MIME[contentType] || "bin";
  // Namespace by user so listings/cleanup stay per-owner; uuid avoids collisions.
  return `uploads/${userId}/${uuidv4()}.${ext}`;
}

export type UploadedObject = {
  url: string;
  key: string;
  contentType: string;
};

/**
 * Uploads bytes and returns the public URL. `userId` scopes the object key to
 * the owner (never trust a path from the client).
 */
export async function uploadObject(input: {
  userId: string;
  filename: string;
  contentType: string;
  body: Buffer | Uint8Array;
}): Promise<UploadedObject> {
  const key = keyFor(input.userId, input.filename, input.contentType);
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
  return { url: `${publicBase()}/${key}`, key, contentType: input.contentType };
}

/**
 * Streams `body` straight to storage as a multipart upload WITHOUT buffering the
 * whole object in memory (audit fix #6). Used for meeting recordings, which can
 * be hundreds of MB — `Buffer.from(await res.arrayBuffer())` would materialize
 * the entire video and OOM the 1 GB worker.
 *
 * `maxBytes` is a hard cap: the stream is watched and the upload is aborted the
 * moment cumulative bytes exceed it (a lying/absent Content-Length can't slip a
 * huge object past a header-only check). Throws on cap breach or upload error.
 */
export async function uploadObjectStream(input: {
  userId: string;
  filename: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
}): Promise<UploadedObject> {
  const key = keyFor(input.userId, input.filename, input.contentType);

  // Tee the source through a counter that aborts once maxBytes is exceeded, so
  // we never accumulate an oversized object in the multipart buffers.
  let seen = 0;
  const capped = input.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > input.maxBytes) {
          controller.error(
            new Error(
              `upload exceeded max size ${input.maxBytes} bytes (aborted mid-stream)`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  const upload = new Upload({
    client: getClient(),
    params: {
      Bucket: bucket(),
      Key: key,
      Body: capped,
      ContentType: input.contentType,
    },
    // 8 MB parts: bounds peak memory to ~queueSize * partSize regardless of the
    // total object size.
    partSize: 8 * 1024 * 1024,
    queueSize: 2,
  });
  await upload.done();
  return { url: `${publicBase()}/${key}`, key, contentType: input.contentType };
}

/**
 * Default TTL (seconds) for presigned GET URLs handed to the vision provider.
 *
 * 6h, not 15min: the URL is signed at upload time (attachment `send`), but the
 * provider only fetches it when the agent actually reaches the vision step —
 * which can be well after send on a long multi-step turn, a retry, or a queued
 * request. A 15min link expired mid-turn and the image 403'd, and nothing
 * re-signs it (the client adapter drops the returned `key`). A turn never
 * outlives 6h, so this always covers it while the link stays short-lived — a
 * leak still expires the same day instead of granting durable, session-less
 * access to a private-bucket object.
 */
const PRESIGN_TTL_SECONDS = 6 * 60 * 60; // 6h

let presignClient: S3Client | null = null;

/**
 * A separate S3 client used ONLY to sign presigned URLs, pointed at the PUBLIC
 * host (S3_PUBLIC_URL) rather than the internal S3_ENDPOINT. SigV4 signs the
 * host as part of the canonical request, so a signature made against
 * `minio:9000` would be rejected when the URL is served from `localhost:9200`.
 * Presigning is a pure local HMAC computation (no network call), so this client
 * never needs to reach the public host — it only needs the host to appear in
 * the signature. Falls back to the main client when no public host is set
 * (real AWS S3, where the public URL is already what the SDK signs).
 */
function getPresignClient(): S3Client {
  if (presignClient) return presignClient;
  const publicHost = env("S3_PUBLIC_URL");
  if (!publicHost) return getClient();
  const accessKeyId = env("S3_ACCESS_KEY_ID");
  const secretAccessKey = env("S3_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Storage not configured: S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY missing.");
  }
  // S3_PUBLIC_URL is `<scheme>://<host>[/<bucket>]`; the SDK endpoint is the
  // host origin (path-style adds the bucket). Strip any path so the bucket
  // isn't doubled.
  const origin = new URL(publicHost).origin;
  presignClient = new S3Client({
    region: env("S3_REGION") ?? "us-east-1",
    endpoint: origin,
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    credentials: { accessKeyId, secretAccessKey },
  });
  return presignClient;
}

/**
 * Presigned GET URL for a stored object (private bucket). Short-lived by design:
 * the vision provider fetches the image within the TTL window; a leaked link
 * expires instead of granting durable, session-less access.
 */
export async function presignGetUrl(
  key: string,
  ttlSeconds: number = PRESIGN_TTL_SECONDS,
): Promise<string> {
  return getSignedUrl(
    getPresignClient(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: ttlSeconds },
  );
}

/**
 * Deletes a stored object by its persisted public URL. Best-effort: used when a
 * meeting is deleted, to reclaim the durable video/attachment bytes. Returns
 * true if the delete was issued, false if the URL isn't one of ours (foreign
 * host, e.g. a Recall signed URL) or storage isn't configured. Never throws —
 * storage failures must not block the record delete.
 */
export async function deleteObjectByUrl(url: string): Promise<boolean> {
  const key = keyFromPublicUrl(url);
  if (!key) return false;
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return true;
  } catch (err) {
    log.error({ err, url }, "delete failed");
    return false;
  }
}

/**
 * Extracts the object key from a persisted public URL (`<publicBase>/<key>`).
 * Returns null when the URL doesn't live under our public base — a foreign host
 * (Recall's signed CDN URL) must never be handed to a DeleteObject on our bucket.
 */
function keyFromPublicUrl(url: string): string | null {
  let base: string;
  try {
    base = publicBase();
  } catch {
    return null;
  }
  const prefix = `${base}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}
