import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * createEmbedder (mastra/model.ts) — the Fireworks embedder for Memory semantic
 * recall. Contract:
 *  - builds an @ai-sdk/openai provider pointed at Fireworks' OpenAI-compatible
 *    /embeddings endpoint (baseURL), authenticated with FIREWORKS_API_KEY;
 *  - defaults to qwen3-embedding-8b, overridable via FIREWORKS_EMBEDDING_MODEL_ID;
 *  - throws (requireEnv) when FIREWORKS_API_KEY is absent — this is WHY the agent
 *    builds memory lazily, so `next build` doesn't hit it env-free.
 *
 * We mock @ai-sdk/openai to capture the config/model without a network call.
 */

const createOpenAI = vi.fn();
// The base model exposes doEmbed; our wrapper delegates to it after injecting the
// `dimensions` provider option. Capture what doEmbed is actually called with.
const baseDoEmbed = vi.fn(async (_options: unknown) => ({
  embeddings: [] as number[][],
  usage: { tokens: 0 },
}));
const embedding = vi.fn((id: string) => ({ id, doEmbed: baseDoEmbed }));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (cfg: unknown) => {
    createOpenAI(cfg);
    return { embedding: (id: string) => embedding(id) };
  },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIREWORKS_API_KEY = "fw-test-key";
  delete process.env.FIREWORKS_EMBEDDING_MODEL_ID;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createEmbedder", () => {
  it("points the provider at Fireworks with the API key", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw-test-key",
    });
  });

  it("defaults to qwen3-embedding-8b", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(embedding).toHaveBeenCalledWith(
      "accounts/fireworks/models/qwen3-embedding-8b",
    );
  });

  it("honors FIREWORKS_EMBEDDING_MODEL_ID override", async () => {
    process.env.FIREWORKS_EMBEDDING_MODEL_ID = "accounts/fireworks/models/custom";
    const { createEmbedder } = await import("@/mastra/model");
    createEmbedder();
    expect(embedding).toHaveBeenCalledWith("accounts/fireworks/models/custom");
  });

  it("throws when FIREWORKS_API_KEY is missing (why memory is lazy)", async () => {
    delete process.env.FIREWORKS_API_KEY;
    const { createEmbedder } = await import("@/mastra/model");
    expect(() => createEmbedder()).toThrow(/FIREWORKS_API_KEY/);
  });

  // Qwen3 natively emits 4096-dim vectors, which pgvector can't index (2000 cap) —
  // that failed every memory save and looped the chat. The embedder truncates to
  // 1024 via MRL by injecting providerOptions.openai.dimensions on EVERY doEmbed
  // call. This is the regression guard for that truncation.
  it("injects dimensions=1024 into every doEmbed call", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    const model = createEmbedder();
    await model.doEmbed({ values: ["hello"] });
    expect(baseDoEmbed).toHaveBeenCalledTimes(1);
    const passed = baseDoEmbed.mock.calls[0][0] as {
      providerOptions?: { openai?: { dimensions?: number } };
    };
    expect(passed?.providerOptions?.openai?.dimensions).toBe(1024);
  });

  it("preserves caller-supplied providerOptions while adding dimensions", async () => {
    const { createEmbedder } = await import("@/mastra/model");
    const model = createEmbedder();
    await model.doEmbed({
      values: ["hi"],
      providerOptions: { openai: { user: "u-1" } },
    });
    const passed = baseDoEmbed.mock.calls[0][0] as {
      providerOptions?: { openai?: { dimensions?: number; user?: string } };
    };
    // Both the injected dimension and the caller's own option survive.
    expect(passed.providerOptions?.openai).toMatchObject({
      dimensions: 1024,
      user: "u-1",
    });
  });

  // Guard: Mastra builds the pgvector index from the ACTUAL returned length. If
  // the provider ignores `dimensions` and returns a wrong-sized vector, we must
  // fail loudly rather than silently build a mismatched index (which, past 2000
  // dims, reopens the chat-loop bug).
  it("throws if the provider returns a vector of the wrong dimension", async () => {
    baseDoEmbed.mockResolvedValueOnce({
      embeddings: [new Array(4096).fill(0)],
      usage: { tokens: 1 },
    });
    const { createEmbedder } = await import("@/mastra/model");
    const model = createEmbedder();
    await expect(model.doEmbed({ values: ["x"] })).rejects.toThrow(/4096-dim/);
  });

  it("accepts a correctly-sized 1024-dim vector", async () => {
    baseDoEmbed.mockResolvedValueOnce({
      embeddings: [new Array(1024).fill(0)],
      usage: { tokens: 1 },
    });
    const { createEmbedder } = await import("@/mastra/model");
    const model = createEmbedder();
    await expect(model.doEmbed({ values: ["x"] })).resolves.toMatchObject({
      embeddings: [expect.any(Array)],
    });
  });
});
