import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/shared/db";

/**
 * Signed `state` for calendar OAuth (CSRF / account-linking).
 *
 * Previously the callback used the raw `state` as userId, WITHOUT session or
 * verification: an attacker would start their own flow, capture their `code`,
 * and call /callback?code=THEIR_CODE&state=VICTIM_ID — linking their own
 * calendar to the victim's account. Here `state` is an HMAC-signed token that
 * binds the userId (from the /start session) + nonce + expiration; the
 * callback validates the signature and validity BEFORE trusting the userId.
 * Without the secret, the token can't be forged.
 */

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: OAUTH_STATE_SECRET");
  }
  return secret;
}

const TTL_MS = 10 * 60 * 1000; // 10 min — consent screen window.

function sign(payload: string): string {
  return createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

/** Generates a signed `state` for the userId (called in /start, authenticated). */
export function signOAuthState(userId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + TTL_MS;
  const payload = `${userId}.${nonce}.${exp}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/** The verified, still-valid contents of a signed OAuth `state`. */
export type VerifiedOAuthState = {
  userId: string;
  /** Random per-flow nonce — consume it (consumeOAuthNonce) to enforce single-use. */
  nonce: string;
  /** State expiry (epoch millis); used as the nonce row's sweep deadline. */
  expMs: number;
};

/**
 * Validates the callback's `state` and returns the embedded userId + nonce + exp.
 * Throws if the signature doesn't match (timing-safe comparison) or the token has
 * expired. Signature/expiry only — call consumeOAuthNonce to enforce single-use.
 */
export function verifyOAuthState(state: string): VerifiedOAuthState {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    throw new Error("invalid_state");
  }

  const parts = decoded.split(".");
  if (parts.length !== 4) throw new Error("invalid_state");
  const [userId, nonce, exp, sig] = parts;

  const expected = sign(`${userId}.${nonce}.${exp}`);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error("invalid_state");
  }

  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || Date.now() > expMs) {
    throw new Error("state_expired");
  }

  return { userId, nonce, expMs };
}

/**
 * Consumes the state's nonce, making the whole `state` SINGLE-USE. The signature
 * proves the state is authentic and unexpired; this proves it hasn't been used
 * before — closing the replay window where the same user re-submits their own
 * still-valid `state` to link a second calendar.
 *
 * Atomic: INSERT the nonce; a unique-violation on the PK means it was already
 * consumed → replay → throw `state_replayed`. One statement, no read-then-write
 * race between two concurrent callbacks carrying the same state.
 */
export async function consumeOAuthNonce(
  nonce: string,
  expMs: number,
): Promise<void> {
  const expiresAt = new Date(expMs);
  const rows = await db.execute<{ nonce: string }>(sql`
    INSERT INTO oauth_state_nonce (nonce, expires_at)
    VALUES (${nonce}, ${expiresAt.toISOString()})
    ON CONFLICT (nonce) DO NOTHING
    RETURNING nonce
  `);
  // No row returned → the nonce already existed → this is a replay.
  if (rows.rows.length === 0) {
    throw new Error("state_replayed");
  }
}

/**
 * Reclaims consumed/expired nonce rows. Each OAuth callback inserts one row that
 * is dead weight the moment its state's 10-min TTL passes — the replay window is
 * closed by then. Without a sweep the table only grows. A periodic cron calls
 * this; deleting past expires_at is safe (a still-valid nonce is never swept).
 * Returns the number of rows removed. Backed by oauth_state_nonce_expires_at_idx.
 */
export async function sweepExpiredOAuthNonces(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM oauth_state_nonce WHERE expires_at < now()
  `);
  return result.rowCount ?? 0;
}
