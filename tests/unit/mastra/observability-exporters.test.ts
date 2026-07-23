import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * createObservability: monta o array de exporters da instância Mastra.
 * Contrato:
 *  - MastraStorageExporter SEMPRE presente (traces/feedback/métricas → PG);
 *  - LangfuseExporter só quando LANGFUSE_PUBLIC_KEY está setado (env-schema
 *    garante o par, então checar uma key basta), recebendo public/secret/
 *    baseUrl/environment;
 *  - ConsoleExporter só fora de produção (visibilidade local).
 *
 * Mockamos as classes de exporter e o ctor de Observability p/ (a) não abrir
 * conexão real e (b) inspecionar QUAIS exporters foram passados. resetModules
 * entre casos limpa o registro de módulos + o mock.
 */

const ORIGINAL = { ...process.env };

// Sentinelas: cada ctor mockado empurra sua marca, então lemos o array
// `exporters` que chegou em `new Observability({ configs })`.
const observabilityCtor = vi.fn();

vi.mock("@mastra/observability", () => ({
  Observability: class {
    constructor(config: unknown) {
      observabilityCtor(config);
    }
  },
  MastraStorageExporter: class {
    kind = "storage";
  },
  ConsoleExporter: class {
    kind = "console";
  },
}));

vi.mock("@mastra/langfuse", () => ({
  LangfuseExporter: class {
    kind = "langfuse";
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  },
}));

// Lê os exporters passados pra Observability na última construção.
function exportersFromLastCall(): Array<{ kind: string; config?: unknown }> {
  const config = observabilityCtor.mock.calls.at(-1)?.[0] as {
    configs: { default: { exporters: Array<{ kind: string; config?: unknown }> } };
  };
  return config.configs.default.exporters;
}

async function build() {
  const { createObservability } = await import("@/mastra/observability");
  createObservability();
  return exportersFromLastCall();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL };
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL };
});

describe("createObservability exporters", () => {
  it("sem keys em produção → só storage", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const exporters = await build();
    const kinds = exporters.map((e) => e.kind);
    expect(kinds).toEqual(["storage"]);
  });

  it("sem keys em dev → storage + console", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const exporters = await build();
    const kinds = exporters.map((e) => e.kind);
    expect(kinds).toEqual(["storage", "console"]);
  });

  it("com keys em produção → storage + langfuse (sem console)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    const exporters = await build();
    const kinds = exporters.map((e) => e.kind);
    expect(kinds).toEqual(["storage", "langfuse"]);
  });

  it("com keys em dev → storage + langfuse + console", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    const exporters = await build();
    const kinds = exporters.map((e) => e.kind);
    expect(kinds).toEqual(["storage", "langfuse", "console"]);
  });

  it("passa public/secret/baseUrl/environment pro LangfuseExporter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-xyz";
    process.env.LANGFUSE_BASE_URL = "https://langfuse.internal";
    const exporters = await build();
    const langfuse = exporters.find((e) => e.kind === "langfuse");
    expect(langfuse?.config).toEqual({
      publicKey: "pk-lf-abc",
      secretKey: "sk-lf-xyz",
      baseUrl: "https://langfuse.internal",
      environment: "production",
    });
  });
});
