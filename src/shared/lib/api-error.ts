import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

/**
 * Central error handling for route handlers (finding E).
 *
 * Several handlers used to pass `err.message` straight into the JSON `detail`
 * field. For exceptions thrown by external libs (fetch, Recall SDK, Postgres
 * driver) that message can carry internal detail — hostnames, URLs, query
 * fragments — leaking implementation to the caller. These helpers log the full
 * error server-side (where you actually debug) and return a GENERIC body to the
 * client, so no unbounded upstream message escapes.
 *
 * Use `serverError` in the `catch` of a handler for unexpected failures; use
 * `badRequest`/`unauthorized`/`notFound` for the expected, client-facing cases
 * where a short, KNOWN detail string is safe to return.
 */

/**
 * Logs the error server-side and returns a generic 5xx JSON response — never
 * the raw exception message. `code` is a stable, non-sensitive slug for the
 * client (e.g. "list_events_failed"); `status` defaults to 500.
 */
export function serverError(
  tag: string,
  err: unknown,
  code = "internal_error",
  status = 500,
): NextResponse {
  // Full error (incl. stack) stays on the server — it does NOT cross the
  // response boundary. console keeps local/dev visibility; Sentry adds grouping
  // + alerting in prod (no-op when SENTRY_DSN is unset). `tag` marks the origin
  // handler and `code` is a stable slug we fingerprint on, so the same failure
  // groups into one issue instead of scattering by stack noise.
  console.error(`[${tag}]`, err);
  Sentry.captureException(err, {
    tags: { handler: tag, code },
    fingerprint: ["{{ default }}", code],
  });
  return NextResponse.json({ error: code }, { status });
}

/** 400 with a KNOWN, safe detail (our own validation message, not an exception). */
export function badRequest(code: string, detail?: string): NextResponse {
  return NextResponse.json(
    detail ? { error: code, detail } : { error: code },
    { status: 400 },
  );
}

/** 401 — unauthenticated/unauthorized. */
export function unauthorized(code = "unauthenticated"): NextResponse {
  return NextResponse.json({ error: code }, { status: 401 });
}

/** 404 — resource not found or not visible to the caller. */
export function notFound(code = "not_found"): NextResponse {
  return NextResponse.json({ error: code }, { status: 404 });
}
