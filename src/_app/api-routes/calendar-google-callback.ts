import { NextResponse } from "next/server";
import {
  exchangeCode,
  fetchUserEmail,
  googleClientId,
  googleClientSecret,
} from "@/server/recall/google-oauth";
import {
  createCalendar,
  deleteCalendar,
  reconnectCalendar,
} from "@/server/recall/calendars";
import {
  findCalendarByEmail,
  saveCalendarMapping,
} from "@/server/recall/calendar-repository";
import { verifyOAuthState, consumeOAuthNonce } from "@/server/recall/oauth-state";
import { getSession } from "@/features/auth/model/session";
import { appPublicUrl } from "@/shared/lib/config";
import { withUserScope } from "@/shared/db/rls";

const PLATFORM = "google_calendar" as const;

/**
 * Google OAuth callback.
 *
 * Steps:
 * 1. Verifies the HMAC-signed `state` (verifyOAuthState) and extracts the userId
 *    from it — NEVER trusts the raw query param. Blocks forged account-linking.
 * 2. Exchanges the `code` for a refresh_token + account email.
 * 3. Dedup by (platform, email): if a disconnected calendar already exists,
 *    reconnects it (PATCH); otherwise creates a new one in Recall.
 * 4. Persists the user↔calendar mapping in our DB.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.json({ error: oauthError }, { status: 400 });
  }
  if (!code || !state) {
    return NextResponse.json(
      { error: "missing code or state" },
      { status: 400 },
    );
  }

  // userId comes from the signed and verified state — not the raw query param.
  let userId: string;
  let nonce: string;
  let expMs: number;
  try {
    ({ userId, nonce, expMs } = verifyOAuthState(state));
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid_state";
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Bind the callback to the CURRENT session: the state proves who STARTED the
  // flow, but the browser hitting /callback must be logged in as that same user.
  // Without this, a signed state captured for user B, replayed in user A's
  // browser, would link B's calendar into A's view. (audit fix #7)
  const session = await getSession();
  if (!session?.user?.id || session.user.id !== userId) {
    return NextResponse.json({ error: "session_mismatch" }, { status: 403 });
  }

  // Single-use: consume the state's nonce so the same signed state can't be
  // replayed within its 10min window (even by its own owner). Done AFTER the
  // session check on purpose — an unauthenticated/mismatched caller must not be
  // able to burn the victim's nonce and DoS their legitimate link. A replay
  // (nonce already consumed) throws → 403.
  try {
    await consumeOAuthNonce(nonce, expMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "state_replayed";
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Absolute URLs from the VALIDATED public app URL — NEVER the request origin.
  // SECURITY (audit fix #7): url.origin is derived from the Host header, which
  // an upstream that doesn't validate Host lets an attacker control. That value
  // fed both the redirect below and the webhook_url sent to Recall — a poisoned
  // Host could redirect the user or point Recall's webhooks at an attacker host.
  // appPublicUrl() reads only the allowlisted env URL (env-schema requires one
  // in production). Recall BLOCKS (403 request_blocked) localhost/private URLs,
  // so in dev (localhost) we omit webhook_url; connect still works.
  const appUrl = appPublicUrl();
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(appUrl);
  const webhookUrl = isLocal ? undefined : `${appUrl}/api/webhooks/recall`;

  try {
    // 1. Google: code → tokens → email
    const tokens = await exchangeCode(code);
    const email = await fetchUserEmail(tokens.accessToken);

    const oauth = {
      oauthClientId: googleClientId(),
      oauthClientSecret: googleClientSecret(),
      oauthRefreshToken: tokens.refreshToken,
      oauthEmail: email,
    };

    // 2. Dedup by (platform, email): reconnect if THIS user already has one
    // (token refresh), otherwise create a new one. Recall doesn't dedup calendars
    // on creation.
    //
    // The lookup + write run under withUserScope so the RLS policies filter to
    // the caller (the DB-level tenant boundary; see drizzle/0008). We ALSO check
    // ownership explicitly below: `findCalendarByEmail` matches on (platform,
    // email) only — two distinct app users can authorize the SAME Google account
    // (shared/service mailbox, account switch, duplicate signup). Reconnecting a
    // row that belongs to ANOTHER user would PATCH the victim's Recall calendar
    // with this caller's refresh token and reassign the row on save — a silent
    // cross-tenant calendar hijack. So we only reconnect a row we actually own;
    // a foreign match is treated as a brand-new calendar for this user.
    // Keep provider network calls outside the RLS transaction so a slow OAuth
    // request never pins a Postgres connection from the pool.
    const existing = await withUserScope(userId, () =>
      findCalendarByEmail(PLATFORM, email),
    );
    const ownedExisting = existing?.userId === userId ? existing : null;
    const createdNew = !ownedExisting;
    const cal = ownedExisting
      ? await reconnectCalendar(ownedExisting.recallCalendarId, oauth)
      : await createCalendar({ platform: PLATFORM, webhookUrl, ...oauth });

    try {
      // Persist in a short, separate transaction. The composite unique
      // constraint closes concurrent duplicate links for the same owner/email.
      await withUserScope(userId, () =>
        saveCalendarMapping({
          recallCalendarId: cal.id,
          userId,
          platform: PLATFORM,
          platformEmail: cal.platform_email ?? email,
          status: cal.status,
        }),
      );
    } catch (err) {
      // If the remote create succeeded but the local source-of-truth write did
      // not, compensate instead of leaving an unmanaged provider calendar.
      if (createdNew) await deleteCalendar(cal.id).catch(() => undefined);
      throw err;
    }

    // Redirects back to the meetings agent UI, signaling the connection.
    return NextResponse.redirect(`${appUrl}/?connected=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "calendar connect failed", detail: message },
      { status: 502 },
    );
  }
}
