import { z } from "zod";

/**
 * Fail-fast environment validation — a leaf util in shared/.
 *
 * Runs once at server boot (see `instrumentation.ts`) so a missing/malformed
 * secret crashes the process with a readable report instead of surfacing as a
 * cryptic runtime error the first time some code path touches the var.
 *
 * This does NOT replace `requireEnv` (still used at call sites for type-narrowing
 * a single var to `string`). It is the boot-time gate that validates the whole
 * surface at once, including conditional requirements (e.g. Bedrock keys only
 * matter when MODEL_PROVIDER=bedrock).
 *
 * `next build` imports route modules to collect page data WITHOUT a real env —
 * so the caller (`instrumentation.ts`) skips validation during the build phase.
 */

// Base surface — vars that are always required for the app to function at all.
const baseSchema = z.object({
  // Postgres — Drizzle + better-auth + Mastra memory. Hard requirement.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // better-auth session/cookie signing secret. Without a stable value across
  // replicas, sessions break in multi-instance — treat as required.
  BETTER_AUTH_SECRET: z
    .string()
    .min(1, "BETTER_AUTH_SECRET is required (openssl rand -base64 32)"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

// Per-1M-token price (USD). Optional, but when set it's fed straight into the
// SigNoz cost computation (llm-telemetry.ts) — a typo like "0,95" or "abc" would
// otherwise silently disable cost (Number(...) → NaN, cost never emitted, panels
// stay empty with no error). Validate the shape at boot so a bad value is a
// startup error instead of a mysteriously empty cost dashboard.
const pricePerMtok = z
  .string()
  .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, {
    message: "must be a non-negative number (USD per 1M tokens)",
  })
  .optional();

// Feature toggles that decide which conditional blocks below are required.
const togglesSchema = z.object({
  MODEL_PROVIDER: z
    .enum(["fireworks", "bedrock"])
    .optional()
    .transform((v) => v ?? "fireworks"),
  // Defaults to dev mode unless NODE_ENV=production (mirrors inngest/client.ts,
  // which fails closed to prod behaviour when the var is unset).
  INNGEST_DEV: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? process.env.NODE_ENV !== "production"
        : v === "true" || v === "1",
    ),
  // Google/calendar OAuth is optional wiring — required only if any of its
  // vars is present (partial config is a misconfiguration we want to catch).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.url().optional(),
  OAUTH_STATE_SECRET: z.string().optional(),
  // Workspace-wide operational access. Authentication alone must never expose
  // the SRE agent or manual health-watch trigger. Either CSV allowlist may be
  // used; when both are absent, operator authorization fails closed.
  OPERATOR_USER_IDS: z.string().optional(),
  OPERATOR_EMAILS: z.string().optional(),
  // Recall webhooks — optional, but if you receive webhooks the secret is
  // required (the routes fail-closed without it anyway).
  RECALL_API_KEY: z.string().optional(),
  RECALL_WEBHOOK_SECRET: z.string().optional(),
  // Token-encryption key for account OAuth tokens at rest (finding A).
  // Optional: absent → tokens stored as-is (dev), present → AES-256-GCM.
  ACCOUNT_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  ACCOUNT_TOKEN_ENCRYPTION_KEY_FALLBACK: z.string().optional(),
  // Langfuse observability export — ships the agent traces + token/cost/latency
  // metrics Mastra already emits to the Langfuse dashboard. Optional and
  // all-or-nothing: absent → traces stay in PG only (MastraStorageExporter);
  // both keys present → LangfuseExporter is added (see mastra/observability.ts).
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.url().optional(),
  // SigNoz observability export (OpenTelemetry-native). Ships the agent traces
  // (with token/cost/latency as `gen_ai.usage.*` span attributes) + Mastra log
  // events, via OTLP, to a SigNoz instance. NOTE: metrics are NOT sent over OTLP
  // — the OtelExporter forwards only traces + logs, so cost/latency dashboards
  // in SigNoz are derived from span attributes. Optional and independent of
  // Langfuse (both can run at once):
  //   - Self-host: set SIGNOZ_ENDPOINT (e.g. http://localhost:4318/v1/traces),
  //     no key needed → OtelExporter uses the OTLP `custom` provider (proto).
  //   - Cloud: set SIGNOZ_API_KEY (+ optional SIGNOZ_REGION) → `signoz` provider
  //     (the built-in provider REQUIRES the ingestion key, hence the split).
  // See mastra/observability.ts.
  // Must be a real URL: it's fed straight to the OTLP exporters, and a typo
  // here fails SILENTLY (the exporter retries into the void, no telemetry ever
  // lands, nothing logs). Validate at boot so a bad value is a startup error
  // instead of an empty dashboard nobody notices for a week.
  SIGNOZ_ENDPOINT: z.url().optional(),
  SIGNOZ_API_KEY: z.string().optional(),
  SIGNOZ_REGION: z.enum(["us", "eu", "in"]).optional(),
  // SigNoz MCP client (the SRE-copilot: the agent queries its OWN telemetry).
  // Independent of the OTLP export vars above — those SEND traces to SigNoz;
  // these let the sreAgent READ them back via the SigNoz MCP server
  // (signoz/signoz-mcp-server). All-or-nothing: without SIGNOZ_MCP_URL the MCP
  // client registers no server and the sreAgent has no tools (safe no-op).
  //   - SIGNOZ_MCP_URL: the MCP server endpoint (HTTP), e.g.
  //     http://localhost:8000/mcp (self-host) — TRANSPORT_MODE=http.
  //   - SIGNOZ_MCP_API_KEY: a SigNoz service-account key (`SIGNOZ-API-KEY`
  //     header) the MCP server uses to query the SigNoz instance.
  //   - SIGNOZ_INSTANCE_URL: which SigNoz instance to query (`X-SigNoz-URL`
  //     header), e.g. http://localhost:8090. Optional if the MCP server has
  //     SIGNOZ_URL baked in.
  SIGNOZ_MCP_URL: z.string().optional(),
  SIGNOZ_MCP_API_KEY: z.string().optional(),
  SIGNOZ_INSTANCE_URL: z.string().optional(),
  // LLM pricing (USD per 1M tokens) for the SigNoz cost signal. Read in
  // llm-telemetry.ts (pricePerToken) to compute `gen_ai.usage.cost` +
  // `gen_ai.client.operation.cost`. All optional and all-or-nothing per pair:
  // cost is emitted ONLY when both INPUT and OUTPUT are set — absent → no cost
  // number ever fabricated (span/metric simply omit cost). The two CACHE prices
  // are refinements: cache-read bills at a fraction of input, cache-write at a
  // premium; when unset each falls back to the plain INPUT price. Declared here
  // so a malformed value fails at boot instead of silently zeroing cost.
  LLM_PRICE_INPUT_PER_MTOK: pricePerMtok,
  LLM_PRICE_OUTPUT_PER_MTOK: pricePerMtok,
  LLM_PRICE_CACHE_READ_PER_MTOK: pricePerMtok,
  LLM_PRICE_CACHE_WRITE_PER_MTOK: pricePerMtok,
  // Slack channel for the sreAgent (ChatOps: mention/DM the SRE-copilot in
  // Slack and it investigates via the SigNoz MCP tools). Wired through Mastra's
  // native `channels` config (@chat-adapter/slack under the hood). All-or-
  // nothing: without SLACK_BOT_TOKEN the agent registers no Slack adapter, so
  // no webhook route is generated and the feature is a safe no-op.
  //   - SLACK_BOT_TOKEN: bot token (`xoxb-...`) from OAuth & Permissions.
  //   - SLACK_SIGNING_SECRET: Basic Information → App Credentials; the adapter
  //     uses it to verify inbound webhook signatures (5-min timestamp window).
  // The generated webhook is POST /api/agents/sreAgent/channels/slack/webhook —
  // point the Slack app's Event Subscriptions + Interactivity request URLs there.
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  // Sentry error tracking — grouping + alerting for the cron/webhook/enrich
  // paths that today only console.error into stdout. Optional: absent → the SDK
  // is never initialized (pure no-op, see sentry.server.config.ts). Set the DSN
  // to turn it on; SENTRY_ENVIRONMENT is a cosmetic tag defaulting to NODE_ENV.
  SENTRY_DSN: z.url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  // Structured logger (pino) verbosity. Optional — the logger defaults to
  // `info` when unset. `debug`/`trace` for verbose runs, `silent` to mute.
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
});

type Toggles = z.infer<typeof togglesSchema>;

/**
 * Cross-field requirements: applied after parsing the toggles so we only demand
 * a secret when the feature that needs it is actually enabled.
 */
function refine(env: NodeJS.ProcessEnv, toggles: Toggles, ctx: z.RefinementCtx) {
  const require = (key: string, why: string) => {
    if (!env[key]) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required ${why}`,
      });
    }
  };

  if (toggles.MODEL_PROVIDER === "bedrock") {
    require("BEDROCK_REGION", "when MODEL_PROVIDER=bedrock");
    require("BEDROCK_MODEL_ID", "when MODEL_PROVIDER=bedrock");
    require("AWS_ACCESS_KEY_ID", "when MODEL_PROVIDER=bedrock");
    require("AWS_SECRET_ACCESS_KEY", "when MODEL_PROVIDER=bedrock");
  } else {
    require("FIREWORKS_API_KEY", "when MODEL_PROVIDER=fireworks (default)");
  }

  // Production Inngest (INNGEST_DEV=false) needs both keys or the app<->inngest
  // handshake fails closed.
  if (!toggles.INNGEST_DEV) {
    require("INNGEST_SIGNING_KEY", "when INNGEST_DEV is off (production)");
    require("INNGEST_EVENT_KEY", "when INNGEST_DEV is off (production)");
  }

  // Production must set a public URL and a real sender: the dev fallbacks
  // (localhost URL, resend.dev sandbox) would otherwise ship silently — emails
  // sent from the sandbox address and deep-links pointing at localhost.
  if (env.NODE_ENV === "production") {
    if (
      !env.NEXT_PUBLIC_APP_URL &&
      !env.APP_URL &&
      !env.BETTER_AUTH_URL
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_APP_URL"],
        message:
          "a public app URL is required in production (set NEXT_PUBLIC_APP_URL, APP_URL, or BETTER_AUTH_URL) — otherwise email links point at localhost",
      });
    }
    if (env.RESEND_API_KEY) {
      require(
        "EMAIL_FROM",
        "in production when RESEND_API_KEY is set (else emails ship from the resend.dev sandbox)",
      );
    }

    // Audit fix #4: password signup without email verification lets anyone claim
    // an address they don't own. In production, verification is REQUIRED by
    // default (see auth.ts); it can only be disabled with the explicit
    // REQUIRE_EMAIL_VERIFICATION=false escape hatch. Enforce the two safe states:
    const verificationDisabled = env.REQUIRE_EMAIL_VERIFICATION === "false";
    if (verificationDisabled) {
      // Escape hatch chosen → password signup must be turned off, otherwise the
      // unverified-signup hole is wide open again.
      if (env.PASSWORD_SIGNUP_ENABLED !== "false") {
        ctx.addIssue({
          code: "custom",
          path: ["REQUIRE_EMAIL_VERIFICATION"],
          message:
            "REQUIRE_EMAIL_VERIFICATION=false in production requires PASSWORD_SIGNUP_ENABLED=false — otherwise users can register unverified email addresses. Either keep verification on (unset this) or disable password signup.",
        });
      }
    } else if (env.PASSWORD_SIGNUP_ENABLED !== "false" && !env.RESEND_API_KEY) {
      // Verification is on (default) with password signup on → we MUST be able to
      // send the verification email, or sign-in locks out every new user.
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message:
          "email verification is required in production with password signup, so a real email provider is required (set RESEND_API_KEY + EMAIL_FROM). To opt out, set PASSWORD_SIGNUP_ENABLED=false and REQUIRE_EMAIL_VERIFICATION=false.",
      });
    }
  }

  // Google OAuth: all-or-nothing. If any var is set, require the full set.
  const googleVars = [
    toggles.GOOGLE_CLIENT_ID,
    toggles.GOOGLE_CLIENT_SECRET,
    toggles.GOOGLE_OAUTH_REDIRECT_URI,
    toggles.OAUTH_STATE_SECRET,
  ];
  if (googleVars.some(Boolean)) {
    require("GOOGLE_CLIENT_ID", "when calendar OAuth is configured");
    require("GOOGLE_CLIENT_SECRET", "when calendar OAuth is configured");
    require("GOOGLE_OAUTH_REDIRECT_URI", "when calendar OAuth is configured");
    require("OAUTH_STATE_SECRET", "when calendar OAuth is configured");
  }

  // Recall: if you set the API key you almost certainly want the webhook secret.
  if (toggles.RECALL_API_KEY) {
    require("RECALL_WEBHOOK_SECRET", "when RECALL_API_KEY is set");
  }

  // Langfuse: all-or-nothing. A lone key is a misconfiguration that would
  // silently fail to export — the exporter needs both to authenticate.
  if (toggles.LANGFUSE_PUBLIC_KEY || toggles.LANGFUSE_SECRET_KEY) {
    require("LANGFUSE_PUBLIC_KEY", "when Langfuse export is configured");
    require("LANGFUSE_SECRET_KEY", "when Langfuse export is configured");
  }
}

const envSchema = baseSchema.and(
  togglesSchema.superRefine((toggles, ctx) =>
    refine(process.env, toggles, ctx),
  ),
);

export type Env = z.infer<typeof envSchema>;

/**
 * Validates process.env against the schema. Throws a single aggregated error
 * (all missing/invalid vars at once) instead of failing one at a time.
 */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment configuration:\n${lines.join("\n")}\n\n` +
        `Fix the vars above (see .env.example) and restart.`,
    );
  }
  return result.data;
}
