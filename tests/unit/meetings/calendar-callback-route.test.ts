import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Google OAuth callback route — the account-linking entry point. Security
 * contract: the userId MUST come from the HMAC-signed `state`, never the raw
 * query, so a forged state can't link a calendar to another user; and dedup by
 * (platform, email) must reconnect an existing calendar instead of creating a
 * duplicate. Untested until now. All network deps mocked.
 */
const exchangeCode = vi.fn();
const fetchUserEmail = vi.fn();
const verifyOAuthState = vi.fn();
const consumeOAuthNonce = vi.fn();
const findCalendarByEmail = vi.fn();
const createCalendar = vi.fn();
const reconnectCalendar = vi.fn();
const deleteCalendar = vi.fn();
const saveCalendarMapping = vi.fn();

vi.mock("@/server/recall/google-oauth", () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
  fetchUserEmail: (...a: unknown[]) => fetchUserEmail(...a),
  googleClientId: () => "gid",
  googleClientSecret: () => "gsecret",
}));
vi.mock("@/server/recall/calendars", () => ({
  createCalendar: (...a: unknown[]) => createCalendar(...a),
  reconnectCalendar: (...a: unknown[]) => reconnectCalendar(...a),
  deleteCalendar: (...a: unknown[]) => deleteCalendar(...a),
}));
vi.mock("@/server/recall/calendar-repository", () => ({
  findCalendarByEmail: (...a: unknown[]) => findCalendarByEmail(...a),
  saveCalendarMapping: (...a: unknown[]) => saveCalendarMapping(...a),
}));
vi.mock("@/server/recall/oauth-state", () => ({
  verifyOAuthState: (...a: unknown[]) => verifyOAuthState(...a),
  consumeOAuthNonce: (...a: unknown[]) => consumeOAuthNonce(...a),
}));

// verifyOAuthState now returns { userId, nonce, expMs }; tests only care about
// userId, so this wraps a userId into the full shape the route destructures.
const verified = (userId: string) => ({
  userId,
  nonce: "test-nonce",
  expMs: Date.now() + 600_000,
});
// The callback binds the flow to the current session (audit fix #7): the
// logged-in user must match the state's userId. Default: session = "u1".
const getSession = vi.fn();
vi.mock("@/features/auth/model/session", () => ({
  getSession: () => getSession(),
}));
// RLS scope records an event trace so tests can assert that provider network
// calls run BETWEEN scopes, never while a withUserScope transaction is open
// (the pinned-connection regression). Each withUserScope call is stamped
// enter/exit around its callback.
const trace: string[] = [];
vi.mock("@/shared/db/rls", () => ({
  withUserScope: async (_userId: string, fn: () => unknown) => {
    trace.push("scope:enter");
    try {
      return await fn();
    } finally {
      trace.push("scope:exit");
    }
  },
}));

const call = (qs: string) =>
  import("@/_app/api-routes/calendar-google-callback").then(({ GET }) =>
    GET(new Request(`https://app.com/api/calendar/google/callback${qs}`)),
  );

beforeEach(() => {
  vi.clearAllMocks();
  trace.length = 0;
  verifyOAuthState.mockReturnValue(verified("u1"));
  consumeOAuthNonce.mockResolvedValue(undefined);
  getSession.mockResolvedValue({ user: { id: "u1" } });
  exchangeCode.mockResolvedValue({ refreshToken: "rt", accessToken: "at" });
  fetchUserEmail.mockResolvedValue("user@x.com");
  createCalendar.mockImplementation(async () => {
    trace.push("createCalendar");
    return { id: "cal-1", status: "connected", platform_email: "user@x.com" };
  });
  reconnectCalendar.mockImplementation(async () => {
    trace.push("reconnectCalendar");
    return { id: "cal-1", status: "connected", platform_email: "user@x.com" };
  });
  findCalendarByEmail.mockResolvedValue(null);
  deleteCalendar.mockResolvedValue(undefined);
});

describe("calendar OAuth callback — validation", () => {
  it("400 when the provider returned an error", async () => {
    const res = await call("?error=access_denied");
    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("400 when code or state is missing", async () => {
    expect((await call("?code=abc")).status).toBe(400); // no state
    expect((await call("?state=xyz")).status).toBe(400); // no code
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("403 on a forged/invalid state — no token exchange", async () => {
    verifyOAuthState.mockImplementation(() => {
      throw new Error("bad_signature");
    });
    const res = await call("?code=abc&state=forged");
    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });
});

describe("calendar OAuth callback — linking uses the VERIFIED userId", () => {
  it("persists the mapping under the userId from the signed state, not the query", async () => {
    verifyOAuthState.mockReturnValue(verified("real-user"));
    getSession.mockResolvedValue({ user: { id: "real-user" } });
    const res = await call("?code=abc&state=signed&user_id=attacker");
    expect(res.status).toBe(307); // redirect
    expect(saveCalendarMapping).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "real-user" }),
    );
  });

  it("403 when the session user does NOT match the state userId (replay in another session)", async () => {
    verifyOAuthState.mockReturnValue(verified("victim"));
    getSession.mockResolvedValue({ user: { id: "attacker" } });
    const res = await call("?code=abc&state=signed-for-victim");
    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });

  it("403 when there is no session at all", async () => {
    getSession.mockResolvedValue(null);
    const res = await call("?code=abc&state=signed");
    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("creates a new calendar when none exists for (platform,email)", async () => {
    findCalendarByEmail.mockResolvedValue(null);
    await call("?code=abc&state=signed");
    expect(createCalendar).toHaveBeenCalledOnce();
    expect(reconnectCalendar).not.toHaveBeenCalled();
  });

  it("reconnects (dedup) the caller's OWN existing calendar instead of duplicating", async () => {
    verifyOAuthState.mockReturnValue(verified("u1"));
    findCalendarByEmail.mockResolvedValue({
      recallCalendarId: "existing",
      userId: "u1", // owned by the same user → safe to reconnect (token refresh)
    });
    await call("?code=abc&state=signed");
    expect(reconnectCalendar).toHaveBeenCalledWith("existing", expect.any(Object));
    expect(createCalendar).not.toHaveBeenCalled();
  });

  it("does NOT reconnect a calendar owned by ANOTHER user (no cross-tenant hijack)", async () => {
    // Two distinct app users authorize the same Google account (shared mailbox,
    // account switch, duplicate signup). The row on that email belongs to the
    // VICTIM; reconnecting it would PATCH the victim's Recall calendar with this
    // caller's refresh token and reassign the row. The callback must create a
    // fresh calendar for the caller instead.
    verifyOAuthState.mockReturnValue(verified("attacker"));
    getSession.mockResolvedValue({ user: { id: "attacker" } });
    findCalendarByEmail.mockResolvedValue({
      recallCalendarId: "victim-cal",
      userId: "victim",
    });
    await call("?code=abc&state=signed");
    expect(reconnectCalendar).not.toHaveBeenCalled();
    expect(createCalendar).toHaveBeenCalledOnce();
    // The mapping is saved under the ATTACKER's id and the NEW calendar id —
    // never touching the victim's row.
    expect(saveCalendarMapping).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "attacker", recallCalendarId: "cal-1" }),
    );
  });

  it("502 when the token exchange fails", async () => {
    exchangeCode.mockRejectedValue(new Error("google 500"));
    const res = await call("?code=abc&state=signed");
    expect(res.status).toBe(502);
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });

  it("deletes a newly-created remote calendar when the local mapping fails", async () => {
    saveCalendarMapping.mockRejectedValue(new Error("unique conflict"));

    const res = await call("?code=abc&state=signed");

    expect(res.status).toBe(502);
    expect(deleteCalendar).toHaveBeenCalledWith("cal-1");
  });

  it("runs the provider create OUTSIDE any RLS transaction (no pinned connection)", async () => {
    // The slow OAuth/provider network call must not sit inside an open
    // withUserScope transaction — otherwise it pins a Postgres connection from
    // the pool for the whole request. The route reads under one scope, closes
    // it, does the network call, then persists under a second short scope.
    await call("?code=abc&state=signed");

    expect(trace).toEqual([
      "scope:enter", // lookup scope (findCalendarByEmail)
      "scope:exit",
      "createCalendar", // network — after the first scope closed
      "scope:enter", // persist scope (saveCalendarMapping)
      "scope:exit",
    ]);
  });

  it("does NOT delete the provider calendar when reconnecting an owned one fails to persist", async () => {
    // Reconnect targets a calendar we already own; compensating by DELETE would
    // destroy the user's live calendar. Only a freshly-created remote is safe to
    // roll back.
    findCalendarByEmail.mockResolvedValue({
      recallCalendarId: "cal-1",
      userId: "u1",
    });
    saveCalendarMapping.mockRejectedValue(new Error("write failed"));

    const res = await call("?code=abc&state=signed");

    expect(res.status).toBe(502);
    expect(reconnectCalendar).toHaveBeenCalled();
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it("leaves no orphan on the happy path (create succeeds, persist succeeds)", async () => {
    saveCalendarMapping.mockResolvedValue(undefined);

    const res = await call("?code=abc&state=signed");

    expect(res.status).toBe(307);
    expect(createCalendar).toHaveBeenCalledOnce();
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it("403 on a replayed state (nonce already consumed) — no token exchange", async () => {
    // The signature is valid and the session matches, but the nonce was already
    // used: consumeOAuthNonce throws state_replayed. The callback must reject
    // before touching the provider, so a replayed link never runs.
    consumeOAuthNonce.mockRejectedValue(new Error("state_replayed"));
    const res = await call("?code=abc&state=signed");
    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveCalendarMapping).not.toHaveBeenCalled();
  });

  it("consumes the nonce AFTER the session check — an unauthenticated caller can't burn it", async () => {
    // Session mismatch must short-circuit BEFORE the nonce is consumed; otherwise
    // an attacker replaying the victim's state in their own browser would burn
    // the victim's nonce and DoS the victim's legitimate link.
    getSession.mockResolvedValue({ user: { id: "attacker" } });
    verifyOAuthState.mockReturnValue(verified("victim"));
    const res = await call("?code=abc&state=signed-for-victim");
    expect(res.status).toBe(403);
    expect(consumeOAuthNonce).not.toHaveBeenCalled();
  });
});
