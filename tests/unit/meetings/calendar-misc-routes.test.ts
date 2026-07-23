import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * team-trends + notifications route handlers — auth guard + query parsing that
 * was untested. team-trends clamps ?limit to [3,200] (default 50);
 * notifications filters on ?unread=1 and computes unreadCount.
 */
const getSession = vi.fn();
const listDynamicsForUser = vi.fn();
const computeTeamTrends = vi.fn();
const listNotifications = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  listDynamicsForUser: (...a: unknown[]) => listDynamicsForUser(...a),
}));
vi.mock("@/server/recall/dynamics-trends", () => ({
  computeTeamTrends: (...a: unknown[]) => computeTeamTrends(...a),
}));
vi.mock("@/server/notifications", () => ({
  listNotifications: (...a: unknown[]) => listNotifications(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (_u: string, fn: () => unknown) => fn(),
}));
// Routes throttle via checkRateLimit (hits pg) — stub it to always allow so the
// unit test needs no DB.
vi.mock("@/shared/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ ok: true, count: 1, retryAfter: 0 })),
}));

const trends = (qs = "") =>
  import("@/_app/api-routes/team-trends").then(({ GET }) =>
    GET(new Request(`https://app.com/api/meetings/trends${qs}`)),
  );
const notifs = (qs = "") =>
  import("@/_app/api-routes/notifications").then(({ GET }) =>
    GET(new Request(`https://app.com/api/notifications${qs}`)),
  );

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  listDynamicsForUser.mockResolvedValue([]);
  computeTeamTrends.mockReturnValue(null);
  listNotifications.mockResolvedValue([]);
});

describe("GET /meetings/trends — limit clamping", () => {
  it("401 without a session", async () => {
    getSession.mockResolvedValue(null);
    expect((await trends()).status).toBe(401);
  });

  it("defaults to 50 when limit is absent or below 3", async () => {
    await trends();
    expect(listDynamicsForUser).toHaveBeenLastCalledWith(50);
    await trends("?limit=1");
    expect(listDynamicsForUser).toHaveBeenLastCalledWith(50);
  });

  it("clamps limit to a max of 200", async () => {
    await trends("?limit=9999");
    expect(listDynamicsForUser).toHaveBeenLastCalledWith(200);
  });

  it("passes a valid in-range limit through", async () => {
    await trends("?limit=25");
    expect(listDynamicsForUser).toHaveBeenLastCalledWith(25);
  });

  it("reports available=false with an empty dynamics set", async () => {
    const res = await trends();
    expect(await res.json()).toEqual({
      available: false,
      meetingsWithDynamics: 0,
      trends: null,
    });
  });
});

describe("GET /notifications — unread filter", () => {
  it("401 without a session", async () => {
    getSession.mockResolvedValue(null);
    expect((await notifs()).status).toBe(401);
  });

  it("passes unreadOnly=false by default", async () => {
    await notifs();
    expect(listNotifications).toHaveBeenCalledWith("u1", { unreadOnly: false });
  });

  it("passes unreadOnly=true on ?unread=1", async () => {
    await notifs("?unread=1");
    expect(listNotifications).toHaveBeenCalledWith("u1", { unreadOnly: true });
  });

  it("computes unreadCount from readAt", async () => {
    listNotifications.mockResolvedValue([
      { id: "1", readAt: null, type: "x", message: "m", link: null, createdAt: "t" },
      { id: "2", readAt: "2026-07-11", type: "x", message: "m", link: null, createdAt: "t" },
    ]);
    const res = await notifs();
    const body = await res.json();
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(2);
  });
});
