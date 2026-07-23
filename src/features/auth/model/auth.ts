import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { db } from "@/shared/db";
import {
  emailVerifyAccount,
  emailResetPassword,
  emailMagicLink,
} from "@/server/email";
import { encryptToken } from "@/server/crypto/token-cipher";

/**
 * better-auth configuration (app identity/session).
 *
 * Social sign-in with Google. `accessType: offline` + `prompt` with `consent`
 * ensure the linked account has a refresh_token — used later to connect the
 * user's calendar to Recall (the calendar flow is separate but reuses the
 * same Google OAuth client).
 *
 * Tables (user/session/account/verification/rateLimit) generated via the
 * `better-auth` CLI and versioned in the Drizzle schema. After changing
 * rateLimit.storage="database" run the better-auth schema/migration
 * generation to create the rateLimit table.
 */

// Email verification for the password flow.
//
// SECURITY (audit fix #4): without verification, anyone can sign up with an
// address they don't control, pick an arbitrary display name, and get a live
// session — enabling identity impersonation and abuse of outbound email
// (meeting summaries to external recipients). So in PRODUCTION verification is
// REQUIRED by default; it can only be turned off with an explicit escape hatch
// (REQUIRE_EMAIL_VERIFICATION=false), which env-schema then forces to be paired
// with a disabled password signup. Outside production it defaults off so local
// dev (console.log email transport) isn't blocked. env-schema additionally
// requires a real email provider (RESEND_API_KEY) whenever verification is on.
const requireEmailVerification =
  process.env.NODE_ENV === "production"
    ? process.env.REQUIRE_EMAIL_VERIFICATION !== "false"
    : process.env.REQUIRE_EMAIL_VERIFICATION === "true";

// Trusted origins (better-auth CSRF/origin check). The production domain comes
// from env (BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL — validated at boot); the
// localhost ports let the same build work through a tunnel and directly on
// localhost in dev. Extra dev origins go in AUTH_EXTRA_TRUSTED_ORIGINS (CSV) so
// no host is hardcoded in source.
const devOrigins =
  process.env.NODE_ENV === "production"
    ? []
    : ["http://localhost:3000", "http://localhost:3001", "http://localhost:3009"];

const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.NEXT_PUBLIC_APP_URL,
  ...(process.env.AUTH_EXTRA_TRUSTED_ORIGINS?.split(",").map((s) => s.trim()) ??
    []),
  ...devOrigins,
].filter((v): v is string => Boolean(v));

// Google OAuth creds — both required together (env-schema enforces the pair).
// `null` when unconfigured so we can skip registering the social provider.
const googleCreds =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }
    : null;

// Encrypts the token columns of an account record in place (only the fields
// that are present). `account` here is better-auth's partial write payload, so
// we accept a loose shape and touch only accessToken/refreshToken.
function encryptAccountTokens<
  T extends { accessToken?: string | null; refreshToken?: string | null },
>(account: T): T {
  const next = { ...account };
  if (account.accessToken) next.accessToken = encryptToken(account.accessToken);
  if (account.refreshToken)
    next.refreshToken = encryptToken(account.refreshToken);
  return next;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  trustedOrigins,
  // Encrypt third-party OAuth tokens at rest (finding A). better-auth stores
  // account.accessToken/refreshToken in plaintext by default; a DB dump would
  // leak every user's Google tokens. These hooks wrap them with AES-256-GCM
  // before persisting (create + refresh/update). No read hook is needed: the
  // app never reads these columns back — the calendar refresh_token flows
  // straight from the OAuth exchange to Recall, not through this table. If a
  // future code path DOES need the plaintext, use decryptToken() on read.
  // encryptToken is a no-op passthrough when ACCOUNT_TOKEN_ENCRYPTION_KEY is
  // unset (dev) and idempotent on already-encrypted values.
  databaseHooks: {
    account: {
      create: {
        async before(account) {
          return { data: encryptAccountTokens(account) };
        },
      },
      update: {
        async before(account) {
          return { data: encryptAccountTokens(account) };
        },
      },
    },
  },
  // Signed cookie cache — avoids a DB read on every getSession() (RSC/routes/
  // tools all call it). Short maxAge keeps revocation lag low; DB stays the
  // source of truth once the cache expires.
  session: {
    cookieCache: { enabled: true, maxAge: 300 },
  },
  emailAndPassword: {
    enabled: true,
    // Opt-out for deployments that want passwordless-only (see env-schema: the
    // only sanctioned way to disable email verification in prod). Sign-IN with
    // existing credentials still works; only new password registrations close.
    disableSignUp: process.env.PASSWORD_SIGNUP_ENABLED === "false",
    requireEmailVerification,
    // Password reset via Resend (forget → email → /reset-password flow).
    sendResetPassword: async ({ user, url }) => {
      await emailResetPassword({ to: user.email, url });
    },
  },
  emailVerification: {
    sendOnSignIn: requireEmailVerification,
    sendVerificationEmail: async ({ user, url }) => {
      await emailVerifyAccount({ to: user.email, url });
    },
  },
  // Native rate limiting — covers login/signup (which Twenty does NOT do).
  // Stricter rules on credential endpoints to slow brute-force and enumeration.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
      "/forget-password": { window: 60, max: 3 },
    },
  },
  // Google social sign-in is optional (calendar OAuth is all-or-nothing, see
  // env-schema). Register the provider only when both creds are present so a
  // missing var fails loud at boot (env-schema) instead of silently coercing
  // `undefined as string` and breaking the OAuth exchange at request time.
  socialProviders: googleCreds
    ? {
        google: {
          clientId: googleCreds.clientId,
          clientSecret: googleCreds.clientSecret,
          accessType: "offline",
          prompt: "select_account consent",
        },
      }
    : {},
  plugins: [
    // Magic link sign-in (passwordless email). Sent via Resend.
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await emailMagicLink({ to: email, url });
      },
    }),
    // nextCookies must be the LAST plugin (it intercepts Set-Cookie on responses).
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
