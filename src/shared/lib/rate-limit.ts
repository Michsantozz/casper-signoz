import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/shared/db";

/**
 * App-level fixed-window rate limiter, backed by the `rate_limit_app` table.
 *
 * Covers expensive routes that better-auth's limiter does NOT reach (it only
 * intercepts /api/auth/*): chat (LLM cost), upload (storage). Persistent + shared
 * across replicas, so the cap holds behind a multi-instance deploy.
 *
 * The whole check is ONE atomic statement (INSERT ... ON CONFLICT DO UPDATE):
 *   - new key → insert with count=1, window=now.
 *   - same window still open → count = count + 1.
 *   - window elapsed → reset count=1, window=now.
 * Doing it in a single upsert avoids the read-then-write race two concurrent
 * requests would otherwise hit (both read count=N, both write N+1, losing a hit).
 * The RETURNING gives us the post-increment count to compare against `max`.
 */
export type RateLimitResult = {
  /** false when the caller is over the limit for this window. */
  ok: boolean;
  /** Hits recorded in the current window after this call. */
  count: number;
  /** Seconds until the current window resets (for the Retry-After header). */
  retryAfter: number;
};

export async function checkRateLimit(opts: {
  /** Bucket key, e.g. `chat:${userId}`. Namespaces the counter per route+caller. */
  key: string;
  /** Window length in seconds. */
  window: number;
  /** Max hits allowed per window. */
  max: number;
}): Promise<RateLimitResult> {
  const { key, window, max } = opts;
  const windowMs = window * 1000;

  // Upsert: increment within the live window, reset once it has elapsed.
  // `EXCLUDED` is the row we tried to insert (now). We compare the stored
  // window_start against now-windowMs to decide reset vs increment.
  const rows = await db.execute<{ count: number; window_start: Date }>(sql`
    INSERT INTO rate_limit_app (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_app.window_start < now() - (${windowMs} || ' milliseconds')::interval
        THEN 1
        ELSE rate_limit_app.count + 1
      END,
      window_start = CASE
        WHEN rate_limit_app.window_start < now() - (${windowMs} || ' milliseconds')::interval
        THEN now()
        ELSE rate_limit_app.window_start
      END
    RETURNING count, window_start
  `);

  const row = rows.rows[0];
  const count = Number(row?.count ?? 1);
  const windowStart = row?.window_start ? new Date(row.window_start) : new Date();
  const elapsedMs = Date.now() - windowStart.getTime();
  const retryAfter = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));

  return { ok: count <= max, count, retryAfter };
}

/**
 * Standard 429 response for a failed rate-limit check. Sets Retry-After so a
 * well-behaved client backs off instead of hammering.
 */
export function rateLimitedResponse(retryAfter: number): Response {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
