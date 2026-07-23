import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * rate-limit.ts — fixed-window limiter guarding chat (LLM cost) and upload
 * (storage). The window-reset SQL runs in Postgres (proven in the integration
 * test); here we mock db.execute and verify the RESULT logic the callers depend
 * on: ok = count <= max, and retryAfter derived from the window start.
 */
const execute = vi.fn();
vi.mock("@/shared/db", () => ({
  db: { execute: (...a: unknown[]) => execute(...a) },
}));

async function importRl() {
  return import("@/shared/lib/rate-limit");
}

beforeEach(() => {
  execute.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("checkRateLimit — result logic", () => {
  it("ok=true while count <= max", async () => {
    const now = new Date("2026-07-11T12:00:00Z");
    execute.mockResolvedValue({ rows: [{ count: 3, window_start: now }] });
    const { checkRateLimit } = await importRl();

    const r = await checkRateLimit({ key: "chat:u1", window: 60, max: 5 });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
  });

  it("ok=false once count exceeds max", async () => {
    const now = new Date("2026-07-11T12:00:00Z");
    execute.mockResolvedValue({ rows: [{ count: 6, window_start: now }] });
    const { checkRateLimit } = await importRl();

    const r = await checkRateLimit({ key: "chat:u1", window: 60, max: 5 });
    expect(r.ok).toBe(false);
  });

  it("boundary: count == max is still ok", async () => {
    const now = new Date("2026-07-11T12:00:00Z");
    execute.mockResolvedValue({ rows: [{ count: 5, window_start: now }] });
    const { checkRateLimit } = await importRl();

    expect((await checkRateLimit({ key: "k", window: 60, max: 5 })).ok).toBe(true);
  });

  it("retryAfter = seconds left in the window (>=1)", async () => {
    // window started 20s ago, 60s window → 40s left.
    const startedAt = new Date("2026-07-11T11:59:40Z");
    execute.mockResolvedValue({ rows: [{ count: 9, window_start: startedAt }] });
    const { checkRateLimit } = await importRl();

    const r = await checkRateLimit({ key: "k", window: 60, max: 5 });
    expect(r.retryAfter).toBe(40);
  });

  it("retryAfter floors at 1 even if the window just elapsed", async () => {
    const startedAt = new Date("2026-07-11T11:59:00Z"); // exactly 60s ago
    execute.mockResolvedValue({ rows: [{ count: 1, window_start: startedAt }] });
    const { checkRateLimit } = await importRl();

    const r = await checkRateLimit({ key: "k", window: 60, max: 5 });
    expect(r.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("defaults gracefully when the row is missing", async () => {
    execute.mockResolvedValue({ rows: [] });
    const { checkRateLimit } = await importRl();

    const r = await checkRateLimit({ key: "k", window: 60, max: 5 });
    expect(r.count).toBe(1);
    expect(r.ok).toBe(true);
  });
});

describe("rateLimitedResponse", () => {
  it("is a 429 with a Retry-After header", async () => {
    const { rateLimitedResponse } = await importRl();
    const res = rateLimitedResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
