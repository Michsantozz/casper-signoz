import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Symmetric encryption for third-party OAuth tokens stored at rest (finding A).
 *
 * better-auth's drizzleAdapter writes `account.accessToken`/`refreshToken` in
 * plaintext by default. A DB dump would then expose every user's Google OAuth
 * tokens. We wrap them via better-auth `databaseHooks` (see features/auth) so
 * they land encrypted with no read hook needed — the app never reads these
 * columns back (the calendar refresh_token flows straight from the OAuth
 * exchange to Recall, never through this table).
 *
 * Envelope format: `enc:v1:<keyId>:<base64(iv | authTag | ciphertext)>`
 *   - keyId ties a value to the key that encrypted it, so PRIMARY + FALLBACK
 *     keys can coexist during rotation (decrypt old data, encrypt new with the
 *     new key) without downtime.
 *   - AES-256-GCM: authenticated encryption (tamper-evident via authTag).
 *
 * Keys come from env (base64, 32 bytes → openssl rand -base64 32):
 *   ACCOUNT_TOKEN_ENCRYPTION_KEY           (primary — used to encrypt)
 *   ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK  (optional — old key, decrypt only)
 *
 * If no primary key is configured, encryption is a no-op passthrough (dev
 * convenience): plaintext in, plaintext out. Set the key in any real env.
 */

const ENVELOPE_PREFIX = "enc:v1:";
const IV_BYTES = 12; // GCM standard nonce size
const AUTH_TAG_BYTES = 16;

type KeyEntry = { id: string; key: Buffer };

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ACCOUNT_TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)",
    );
  }
  return key;
}

// Short, stable id for a key (first 8 hex of its sha256) — lets the envelope
// name which key it used without embedding the key itself.
function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// Resolved once at module load. Primary encrypts; both are candidates to decrypt.
const primaryRaw = parseKey(process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY);
const fallbackRaw = parseKey(process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK);

const primary: KeyEntry | null = primaryRaw
  ? { id: keyId(primaryRaw), key: primaryRaw }
  : null;

const decryptKeys: KeyEntry[] = [primary, fallbackRaw ? { id: keyId(fallbackRaw), key: fallbackRaw } : null].filter(
  (k): k is KeyEntry => k !== null,
);

function isEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Boot guard: token encryption is a no-op passthrough when no primary key is
 * configured (dev convenience). In production that silently persists Google
 * OAuth access/refresh tokens in PLAINTEXT with no operator-visible signal — a
 * DB dump/backup leak then exposes every connected user's calendar credentials.
 *
 * So: fail-fast in production if the key is missing; warn (never block) in dev
 * and test, mirroring assertRlsHardening's best-effort posture. Call once on
 * server boot.
 */
export function assertTokenEncryptionKey(): void {
  if (primary) return;
  const msg =
    "[crypto] ACCOUNT_TOKEN_ENCRYPTION_KEY is not set — OAuth tokens are stored " +
    "in PLAINTEXT. Set a 32-byte base64 key (openssl rand -base64 32).";
  if (process.env.NODE_ENV === "production") {
    throw new Error(msg);
  }
  console.warn(msg);
}

/**
 * Encrypts a token into the versioned envelope. No-op (returns input) when no
 * primary key is configured, or when the value is already an envelope
 * (idempotent — better-auth may run the update hook on an already-stored value).
 */
export function encryptToken(plaintext: string): string {
  if (!primary) return plaintext;
  if (isEnvelope(plaintext)) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return `${ENVELOPE_PREFIX}${primary.id}:${payload}`;
}

/**
 * Decrypts an envelope back to plaintext. Returns the input unchanged if it is
 * not an envelope (plaintext written before encryption was enabled, or when no
 * key is configured) — so reads stay backward-compatible.
 */
export function decryptToken(value: string): string {
  if (!isEnvelope(value)) return value;

  const rest = value.slice(ENVELOPE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) throw new Error("Malformed token envelope: missing keyId");
  const id = rest.slice(0, sep);
  const raw = Buffer.from(rest.slice(sep + 1), "base64");

  const entry = decryptKeys.find(
    (k) => timingSafeEqualStr(k.id, id),
  );
  if (!entry) {
    throw new Error(
      `No encryption key matches envelope keyId "${id}" — check ACCOUNT_TOKEN_ENCRYPTION_KEY(_FALLBACK)`,
    );
  }

  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", entry.key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

// Constant-time string compare for the keyId lookup (ids are non-secret, but
// this avoids leaking a length/short-circuit signal and keeps the intent clear).
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
