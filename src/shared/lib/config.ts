/**
 * App-wide default constants — a leaf util in shared/. Safe to import from any
 * layer (client or server): no server-only runtime, no business logic.
 *
 * Kept here (not inline at call sites) so a single change moves every default
 * together instead of leaving stale copies drifting across files.
 */

/**
 * Fallback IANA timezone when the caller/browser doesn't provide one. Overridable
 * via NEXT_PUBLIC_DEFAULT_TIME_ZONE (public: read on both client and server).
 * Defaults to BRT since the app's first deployment serves a Brazilian team.
 */
export const DEFAULT_TIME_ZONE =
  process.env.NEXT_PUBLIC_DEFAULT_TIME_ZONE || "America/Sao_Paulo";

/**
 * Public base URL of the app — used to build absolute links (emails, redirects).
 * Precedence: NEXT_PUBLIC_APP_URL → APP_URL → BETTER_AUTH_URL → dev localhost.
 *
 * The dev fallback matches the actual dev port (`next dev -p 3001`). Production
 * MUST set one of the URL vars: env-schema (validateEnv) fails the boot if none
 * is present when NODE_ENV=production, so this fallback never ships to prod.
 */
export function appPublicUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3001"
  );
}
