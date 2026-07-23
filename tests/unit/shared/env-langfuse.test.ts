import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * env-schema: bloco Langfuse (observability export). É opcional e
 * all-or-nothing — uma key solitária é misconfiguration que falharia
 * silenciosamente no export, então `validateEnv()` tem que barrar no boot.
 *
 * validateEnv lê `process.env` na hora e é SÍNCRONO (throw agregado). O único
 * await aqui é o dynamic import do módulo; a validação em si roda inline.
 * resetModules garante schema fresh a cada caso.
 */

const ORIGINAL = { ...process.env };

// Env mínimo pra passar o resto do schema (base + toggles default fireworks).
// Sem isso o parse falha por outros motivos e o teste ficaria ambíguo.
function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://x/y",
    BETTER_AUTH_SECRET: "unit-test-secret",
    NODE_ENV: "test",
    FIREWORKS_API_KEY: "fw-unit-test",
  };
}

// Carrega o validador fresh e roda inline. Devolve um thunk pra usar com
// expect(fn).toThrow / .not.toThrow, já que validateEnv é síncrono.
async function loadValidate() {
  const { validateEnv } = await import("@/shared/lib/env-schema");
  return validateEnv;
}

beforeEach(() => {
  vi.resetModules();
  process.env = baseEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("env-schema Langfuse (all-or-nothing)", () => {
  it("aceita ausência total das keys (export desligado)", async () => {
    const validateEnv = await loadValidate();
    const env = validateEnv();
    expect(env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
    expect(env.LANGFUSE_SECRET_KEY).toBeUndefined();
  });

  it("aceita o par completo (public + secret)", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    const validateEnv = await loadValidate();
    const env = validateEnv();
    expect(env.LANGFUSE_PUBLIC_KEY).toBe("pk-lf-abc");
    expect(env.LANGFUSE_SECRET_KEY).toBe("sk-lf-xyz");
  });

  it("aceita baseUrl junto do par (self-host)", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.internal";
    const validateEnv = await loadValidate();
    const env = validateEnv();
    expect(env.LANGFUSE_BASE_URL).toBe("https://langfuse.internal");
  });

  it("REJEITA public key sozinha (secret faltando)", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    const validateEnv = await loadValidate();
    expect(() => validateEnv()).toThrow(/LANGFUSE_SECRET_KEY is required/);
  });

  it("REJEITA secret key sozinha (public faltando)", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    const validateEnv = await loadValidate();
    expect(() => validateEnv()).toThrow(/LANGFUSE_PUBLIC_KEY is required/);
  });

  it("REJEITA baseUrl malformado", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    process.env.LANGFUSE_BASE_URL = "not-a-url";
    const validateEnv = await loadValidate();
    expect(() => validateEnv()).toThrow();
  });
});
