import { NextResponse } from "next/server";
import { buildConsentUrl } from "@/server/recall/google-oauth";
import { signOAuthState } from "@/server/recall/oauth-state";
import { getSession } from "@/features/auth/model/session";

/**
 * Starts the Google OAuth flow (calendar connection): redirects to the consent screen.
 *
 * The calendar owner is the authenticated user (better-auth session), not a
 * query param. The user_id goes in the HMAC-signed `state` (signOAuthState) and
 * is verified in the callback before any write — blocks forged account-linking.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.redirect(buildConsentUrl(signOAuthState(session.user.id)));
}
