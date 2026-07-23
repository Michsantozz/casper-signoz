"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/**
 * better-auth client (browser).
 *
 * NO fixed baseURL on purpose: better-auth uses the CURRENT ORIGIN (relative).
 * Fixing NEXT_PUBLIC_APP_URL (public domain) broke with CORS when accessed from
 * a different origin (e.g. localhost:3009 in dev hitting the tunnel domain).
 * Relative works on any host — localhost, tunnel, and production.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
