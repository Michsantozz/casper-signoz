import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * HTTP edge helpers for routes: CSRF protection via Origin and zod body
 * parsing. Centralized so every mutating route applies the same policy.
 */

/**
 * CSRF protection: on mutating requests, requires the Origin header (when
 * present) to match the request's host. Blocks cross-site POSTs. Same-origin
 * requests from the app itself (fetch) always pass.
 *
 * Returns a 403 NextResponse if invalid, or null if OK.
 */
export async function assertSameOrigin(): Promise<NextResponse | null> {
  const h = await headers();
  const origin = h.get("origin");
  // No Origin (e.g. direct GET navigation, some server-side clients) → no
  // classic CSRF vector; let it pass. CSRF requires a cross-site Origin.
  if (!origin) return null;

  const host = h.get("host");
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return NextResponse.json({ error: "csrf_origin_mismatch" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "csrf_invalid_origin" }, { status: 403 });
  }
  return null;
}

/**
 * Rejects a request whose body is larger than `maxBytes` BEFORE it is parsed,
 * using the declared Content-Length. Parsing first (req.json()/req.formData())
 * materializes the whole body in memory — a hostile or accidental huge payload
 * would exhaust memory/CPU before any size check. This is a cheap pre-parse
 * gate; it is NOT a substitute for a limit at the proxy/server (Content-Length
 * can be absent or lie under chunked encoding), but it stops the common case.
 *
 * Returns a 413 NextResponse when over the limit, or null to proceed.
 */
export function assertBodyWithinLimit(
  req: Request,
  maxBytes: number,
): NextResponse | null {
  const header = req.headers.get("content-length");
  if (header === null) return null; // no declared length → can't pre-check here
  const length = Number(header);
  if (!Number.isFinite(length) || length < 0) {
    return NextResponse.json({ error: "invalid_content_length" }, { status: 400 });
  }
  if (length > maxBytes) {
    return NextResponse.json(
      { error: "payload_too_large", maxBytes },
      { status: 413 },
    );
  }
  return null;
}

/**
 * Parses + validates the JSON body against a zod schema. Returns `{ data }`
 * or `{ response }` (error NextResponse) — the caller early-returns on error.
 *
 * When `maxBytes` is given, a pre-parse Content-Length check rejects oversized
 * bodies (413) before req.json() reads them into memory.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
  maxBytes?: number,
): Promise<{ data: z.infer<T>; response?: never } | { data?: never; response: NextResponse }> {
  if (maxBytes !== undefined) {
    const tooLarge = assertBodyWithinLimit(req, maxBytes);
    if (tooLarge) return { response: tooLarge };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      response: NextResponse.json({ error: "invalid_json" }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          error: "validation_failed",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data };
}
