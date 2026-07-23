import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";

/**
 * token-cipher (finding A): AES-256-GCM encryption of third-party OAuth tokens
 * at rest. Keys are resolved at module load from env, so every test resets
 * modules and sets the key(s) before importing — same pattern as oauth-state.
 *
 * Contract:
 *  - envelope format `enc:v1:<keyId>:<base64>`; keyId = first 8 hex of sha256(key);
 *  - round-trip: decrypt(encrypt(x)) === x;
 *  - ciphertext never contains the plaintext;
 *  - idempotent: encrypting an already-encrypted value is a no-op;
 *  - no primary key → passthrough (dev), both encrypt/decrypt return input;
 *  - decrypt is backward-compatible with legacy plaintext (not an envelope);
 *  - tampered ciphertext is rejected (GCM authTag);
 *  - FALLBACK key decrypts values encrypted with the old key (rotation);
 *  - a value whose keyId matches no configured key throws.
 */

const ORIGINAL = { ...process.env };
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const keyIdOf = (b64: string) =>
  createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 8);

beforeEach(() => {
  vi.resetModules();
  delete process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY;
  delete process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const SECRET = "ya29.a0AfB_averyLongGoogleOAuthAccessToken-0123456789xyz";

describe("token-cipher — with a primary key", () => {
  async function load() {
    process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY = KEY_A;
    return import("@/server/crypto/token-cipher");
  }

  it("round-trip: decrypt(encrypt(x)) === x", async () => {
    const { encryptToken, decryptToken } = await load();
    const enc = encryptToken(SECRET);
    expect(decryptToken(enc)).toBe(SECRET);
  });

  it("produces the versioned envelope with the right keyId", async () => {
    const { encryptToken } = await load();
    const enc = encryptToken(SECRET);
    expect(enc.startsWith(`enc:v1:${keyIdOf(KEY_A)}:`)).toBe(true);
  });

  it("ciphertext never contains the plaintext", async () => {
    const { encryptToken } = await load();
    const enc = encryptToken(SECRET);
    expect(enc.includes(SECRET)).toBe(false);
  });

  it("is non-deterministic (fresh IV per call)", async () => {
    const { encryptToken } = await load();
    expect(encryptToken(SECRET)).not.toBe(encryptToken(SECRET));
  });

  it("is idempotent: re-encrypting an envelope is a no-op", async () => {
    const { encryptToken } = await load();
    const once = encryptToken(SECRET);
    expect(encryptToken(once)).toBe(once);
  });

  it("rejects tampered ciphertext (GCM authTag)", async () => {
    const { encryptToken, decryptToken } = await load();
    const enc = encryptToken(SECRET);
    // Flip the last 4 base64 chars of the payload.
    const tampered = enc.slice(0, -4) + (enc.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("decrypt is backward-compatible with legacy plaintext", async () => {
    const { decryptToken } = await load();
    // A value written before encryption was enabled — not an envelope.
    expect(decryptToken(SECRET)).toBe(SECRET);
  });

  it("throws on an envelope with no matching key", async () => {
    const { decryptToken } = await load();
    // Envelope claiming a keyId we don't hold.
    const bogus = `enc:v1:deadbeef:${Buffer.from("x").toString("base64")}`;
    expect(() => decryptToken(bogus)).toThrow(/No encryption key/);
  });

  it("throws on a malformed envelope (missing keyId separator)", async () => {
    const { decryptToken } = await load();
    expect(() => decryptToken("enc:v1:onlyoneterm")).toThrow(/Malformed/);
  });
});

describe("token-cipher — no key configured (dev passthrough)", () => {
  async function load() {
    return import("@/server/crypto/token-cipher");
  }

  it("encrypt is a no-op passthrough", async () => {
    const { encryptToken } = await load();
    expect(encryptToken(SECRET)).toBe(SECRET);
  });

  it("decrypt returns plaintext unchanged", async () => {
    const { decryptToken } = await load();
    expect(decryptToken(SECRET)).toBe(SECRET);
  });
});

describe("token-cipher — key rotation (PRIMARY + FALLBACK)", () => {
  it("FALLBACK key decrypts values encrypted under the old key", async () => {
    // Encrypt under KEY_A (as primary).
    vi.resetModules();
    process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY = KEY_A;
    delete process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK;
    const { encryptToken } = await import("@/server/crypto/token-cipher");
    const encOld = encryptToken(SECRET);

    // Rotate: KEY_B becomes primary, KEY_A the fallback.
    vi.resetModules();
    process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK = KEY_A;
    const { decryptToken, encryptToken: encryptNew } = await import(
      "@/server/crypto/token-cipher"
    );

    // Old value still decrypts...
    expect(decryptToken(encOld)).toBe(SECRET);
    // ...and new writes use the new primary keyId.
    expect(encryptNew(SECRET).startsWith(`enc:v1:${keyIdOf(KEY_B)}:`)).toBe(true);
  });

  it("rejects a key that is not 32 bytes", async () => {
    vi.resetModules();
    process.env.ACCOUNT_TOKEN_ENCRYPTION_KEY = Buffer.from("too-short").toString(
      "base64",
    );
    await expect(import("@/server/crypto/token-cipher")).rejects.toThrow(
      /32 bytes/,
    );
  });
});
