import { describe, it, expect, vi, afterEach } from "vitest";
import {
  serverError,
  badRequest,
  unauthorized,
  notFound,
} from "@/shared/lib/api-error";
import * as Sentry from "@sentry/nextjs";

/**
 * api-error (finding E): central handlers that keep raw exception messages off
 * the response. Contract:
 *  - serverError logs the FULL error server-side but returns only a generic
 *    code — never err.message/stack (which can carry upstream hostnames/URLs);
 *  - status/code are configurable, with sane defaults;
 *  - serverError forwards the FULL error to Sentry with tag/code/fingerprint;
 *  - badRequest returns a KNOWN, safe detail only when explicitly provided.
 */

// Mock Sentry so no SDK side-effects run and we can assert the capture call.
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(Sentry.captureException).mockClear();
});

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("serverError", () => {
  it("logs the full error server-side but never leaks its message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "connect ECONNREFUSED db.internal.host:5432 (leaky detail)";
    const res = serverError("calendar-events", new Error(secret), "list_failed", 502);

    expect(res.status).toBe(502);
    const json = await body(res);
    expect(json).toEqual({ error: "list_failed" }); // generic only
    expect(JSON.stringify(json)).not.toContain(secret);
    expect(JSON.stringify(json)).not.toContain("ECONNREFUSED");

    // The real error DID reach the server log (for debugging).
    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0];
    expect(String(logged[0])).toContain("calendar-events");
    expect(logged[1]).toBeInstanceOf(Error);
  });

  it("defaults to 500 / internal_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = serverError("tag", new Error("boom"));
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: "internal_error" });
  });

  it("never exposes a stack trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    const res = serverError("tag", err);
    const raw = JSON.stringify(await body(res));
    expect(raw).not.toContain("at ");
    expect(raw).not.toContain(err.stack ?? "###");
  });

  it("handles non-Error throwables without leaking them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = serverError("tag", { secret: "s3cr3t-object" }, "weird");
    const raw = JSON.stringify(await body(res));
    expect(raw).not.toContain("s3cr3t-object");
    expect(await body(serverError("tag", "raw string", "weird"))).toEqual({
      error: "weird",
    });
  });

  it("forwards the full error to Sentry with handler tag + code fingerprint", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    serverError("enrich-webhook", err, "enrich_failed");

    expect(Sentry.captureException).toHaveBeenCalledOnce();
    const [captured, ctx] = vi.mocked(Sentry.captureException).mock.calls[0];
    // The REAL error object reaches Sentry (grouping needs the stack), unlike
    // the generic body the client gets.
    expect(captured).toBe(err);
    expect(ctx).toMatchObject({
      tags: { handler: "enrich-webhook", code: "enrich_failed" },
      fingerprint: ["{{ default }}", "enrich_failed"],
    });
  });

  it("captures non-Error throwables too (still reported, not swallowed)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    serverError("tag", "raw string failure", "weird");
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(vi.mocked(Sentry.captureException).mock.calls[0][0]).toBe(
      "raw string failure",
    );
  });
});

describe("badRequest / unauthorized / notFound", () => {
  it("badRequest returns only the known detail when provided", async () => {
    const res = badRequest("bad_date", "expected ?date=yyyy-mm-dd");
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({
      error: "bad_date",
      detail: "expected ?date=yyyy-mm-dd",
    });
  });

  it("badRequest omits detail when not given", async () => {
    const res = badRequest("bad_input");
    expect(await body(res)).toEqual({ error: "bad_input" });
  });

  it("unauthorized defaults to 401 unauthenticated", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: "unauthenticated" });
  });

  it("notFound defaults to 404 not_found", async () => {
    const res = notFound();
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "not_found" });
  });
});
