import * as Sentry from "@sentry/nextjs";

/**
 * Sentry server-side init — imported once at boot from `instrumentation.ts`
 * (Node runtime only). This is the error-tracking pillar: today unexpected
 * failures in the cron/webhook/enrich paths only `console.error` to the
 * container stdout, so a broken webhook or a failed enrich passes unnoticed
 * until someone spots missing data. Sentry gives grouping + alerting on those.
 *
 * Fully env-gated: with no `SENTRY_DSN` the SDK is never initialized, so this
 * is a pure no-op in dev/self-host that doesn't set a DSN — zero behavioural
 * change. Set `SENTRY_DSN` (+ optional SENTRY_ENVIRONMENT / release) to turn it
 * on. Mirrors how Twenty gates Sentry behind `EXCEPTION_HANDLER_DRIVER=sentry`.
 */
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    release: process.env.APP_VERSION ?? process.env.GIT_HASH,
    // Performance tracing: full in dev, sampled in prod to bound cost. Next
    // route handlers + Server Actions are auto-instrumented once this is on.
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  });
}
