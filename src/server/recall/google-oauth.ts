import "server-only";
import { requireEnv } from "@/shared/lib/env";

/**
 * Google OAuth 2.0 (authorization code flow, server-side).
 *
 * Flow: buildConsentUrl() → user authorizes → callback with `code` →
 * exchangeCode() returns refresh_token + email. The refresh_token is then
 * handed to Recall (createCalendar), which manages access-token renewal.
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Calendar OAuth scopes.
 *
 * `calendar.events` (read+write) allows both the Recall integration (which
 * reads events) and creating events with a Meet link via the Google Calendar API.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleClientId(): string {
  return requireEnv("GOOGLE_CLIENT_ID");
}
export function googleClientSecret(): string {
  return requireEnv("GOOGLE_CLIENT_SECRET");
}
export function googleRedirectUri(): string {
  return requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
}

/**
 * URL of the Google consent screen.
 *
 * `access_type=offline` + `prompt=consent` guarantee a refresh_token always
 * comes back (without this Google only returns it on the first authorization).
 * `state` carries the user_id (signed/opaque on the app side) to tie the
 * callback to the logged-in user.
 */
export function buildConsentUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

/** Exchanges the authorization code for an access_token + refresh_token. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token exchange failed: ${data.error ?? res.status} ${
        data.error_description ?? ""
      }`.trim(),
    );
  }
  if (!data.refresh_token) {
    // Without offline/consent, or re-authorization without prompt — can't
    // create the calendar in Recall (refresh_token is required).
    throw new Error(
      "Google did not return a refresh_token. Ensure access_type=offline & prompt=consent.",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 0,
  };
}

/** Fetches the email of the authorized account (calendar dedup key). */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as { email?: string };
  if (!res.ok || !data.email) {
    throw new Error(`Google userinfo failed: ${res.status}`);
  }
  return data.email;
}
