import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * env-schema (finding D): fail-fast validation of process.env at boot.
 *
 * validateEnv() reads process.env directly, so each test mutates it and calls
 * fresh. Contract:
 *  - base vars (DATABASE_URL, BETTER_AUTH_SECRET) always required;
 *  - MODEL_PROVIDER=fireworks (default) requires FIREWORKS_API_KEY;
 *  - MODEL_PROVIDER=bedrock requires the AWS/Bedrock quartet;
 *  - INNGEST_DEV=false requires both Inngest keys;
 *  - Google OAuth is all-or-nothing (partial config fails);
 *  - RECALL_API_KEY set requires RECALL_WEBHOOK_SECRET;
 *  - the error aggregates ALL missing vars at once.
 */

const ORIGINAL = { ...process.env };

// A minimal env that passes the base + default (fireworks) requirements.
function baseValidEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "a".repeat(32),
    FIREWORKS_API_KEY: "fw-key",
  };
}

beforeEach(() => {
  vi.resetModules();
  // Start from a clean slate so leftover host env vars don't mask a failure.
  process.env = {} as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function validate() {
  const { validateEnv } = await import("@/shared/lib/env-schema");
  return validateEnv();
}

describe("validateEnv — base requirements", () => {
  it("passes with a minimal valid env (fireworks default)", async () => {
    Object.assign(process.env, baseValidEnv());
    await expect(validate()).resolves.toBeTruthy();
  });

  it("fails when DATABASE_URL is missing", async () => {
    Object.assign(process.env, baseValidEnv());
    delete process.env.DATABASE_URL;
    await expect(validate()).rejects.toThrow(/DATABASE_URL/);
  });

  it("fails when BETTER_AUTH_SECRET is missing", async () => {
    Object.assign(process.env, baseValidEnv());
    delete process.env.BETTER_AUTH_SECRET;
    await expect(validate()).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });

  it("aggregates every missing var into one error", async () => {
    // Empty env → DATABASE_URL + BETTER_AUTH_SECRET + FIREWORKS_API_KEY all fail.
    await expect(validate()).rejects.toThrow(
      /DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*FIREWORKS_API_KEY/,
    );
  });
});

describe("validateEnv — MODEL_PROVIDER", () => {
  it("bedrock requires the AWS/Bedrock quartet", async () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://u:p@h:5432/d",
      BETTER_AUTH_SECRET: "a".repeat(32),
      MODEL_PROVIDER: "bedrock",
    });
    await expect(validate()).rejects.toThrow(
      /BEDROCK_REGION[\s\S]*AWS_ACCESS_KEY_ID[\s\S]*AWS_SECRET_ACCESS_KEY/,
    );
  });

  it("bedrock passes with all four vars set", async () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://u:p@h:5432/d",
      BETTER_AUTH_SECRET: "a".repeat(32),
      MODEL_PROVIDER: "bedrock",
      BEDROCK_REGION: "us-east-1",
      BEDROCK_MODEL_ID: "model",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    await expect(validate()).resolves.toBeTruthy();
  });

  it("does NOT require FIREWORKS_API_KEY when provider is bedrock", async () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgres://u:p@h:5432/d",
      BETTER_AUTH_SECRET: "a".repeat(32),
      MODEL_PROVIDER: "bedrock",
      BEDROCK_REGION: "us-east-1",
      BEDROCK_MODEL_ID: "model",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    const env = await validate();
    expect(env.MODEL_PROVIDER).toBe("bedrock");
  });
});

describe("validateEnv — conditional secrets", () => {
  it("production Inngest (INNGEST_DEV=false) requires both keys", async () => {
    Object.assign(process.env, baseValidEnv(), { INNGEST_DEV: "false" });
    await expect(validate()).rejects.toThrow(
      /INNGEST_SIGNING_KEY[\s\S]*INNGEST_EVENT_KEY/,
    );
  });

  it("Google OAuth is all-or-nothing: partial config fails", async () => {
    Object.assign(process.env, baseValidEnv(), {
      GOOGLE_CLIENT_ID: "id-only", // the other three missing
    });
    await expect(validate()).rejects.toThrow(
      /GOOGLE_CLIENT_SECRET[\s\S]*GOOGLE_OAUTH_REDIRECT_URI[\s\S]*OAUTH_STATE_SECRET/,
    );
  });

  it("Google OAuth passes when the full set is present", async () => {
    Object.assign(process.env, baseValidEnv(), {
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://app.example.com/callback",
      OAUTH_STATE_SECRET: "state-secret",
    });
    await expect(validate()).resolves.toBeTruthy();
  });

  it("RECALL_API_KEY set requires RECALL_WEBHOOK_SECRET", async () => {
    Object.assign(process.env, baseValidEnv(), { RECALL_API_KEY: "rk" });
    await expect(validate()).rejects.toThrow(/RECALL_WEBHOOK_SECRET/);
  });

  it("neither Recall var → no requirement (feature off)", async () => {
    Object.assign(process.env, baseValidEnv());
    await expect(validate()).resolves.toBeTruthy();
  });
});

describe("validateEnv — Sentry (optional)", () => {
  it("passes with no SENTRY_DSN (error tracking off)", async () => {
    Object.assign(process.env, baseValidEnv());
    const env = await validate();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it("accepts a valid DSN url + environment tag", async () => {
    Object.assign(process.env, baseValidEnv(), {
      SENTRY_DSN: "https://abc@o123.ingest.sentry.io/456",
      SENTRY_ENVIRONMENT: "production",
    });
    const env = await validate();
    expect(env.SENTRY_DSN).toBe("https://abc@o123.ingest.sentry.io/456");
    expect(env.SENTRY_ENVIRONMENT).toBe("production");
  });

  it("rejects a malformed DSN (not a url)", async () => {
    Object.assign(process.env, baseValidEnv(), { SENTRY_DSN: "not-a-dsn" });
    await expect(validate()).rejects.toThrow(/SENTRY_DSN/);
  });
});
