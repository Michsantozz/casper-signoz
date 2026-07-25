import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createAmazonBedrock = vi.fn((_config: unknown) => (id: string) => ({
  provider: "bedrock",
  id,
}));
const chat = vi.fn((id: string) => ({ provider: "fireworks", id }));
const createOpenAI = vi.fn((_config: unknown) => ({
  chat,
  embedding: vi.fn(),
}));
const getModelHealth = vi.fn();
const emitFailoverSpan = vi.fn();
const ORIGINAL_ENV = { ...process.env };

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: (config: unknown) => createAmazonBedrock(config),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (config: unknown) => createOpenAI(config),
}));
vi.mock("@/mastra/model-health", () => ({
  getModelHealth: (...args: unknown[]) => getModelHealth(...args),
  emitFailoverSpan: (...args: unknown[]) => emitFailoverSpan(...args),
}));
vi.mock("@/mastra/llm-telemetry", () => ({
  withLlmTelemetry: (model: unknown) => model,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.MODEL_PROVIDER = "fireworks";
  process.env.FIREWORKS_API_KEY = "fw-key";
  process.env.BEDROCK_REGION = "us-east-1";
  process.env.BEDROCK_MODEL_ID = "bedrock-model";
  process.env.AWS_ACCESS_KEY_ID = "access";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  getModelHealth.mockReturnValue({
    degraded: false,
    reason: "healthy",
    source: "healthy",
    detail: {},
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("telemetry-driven model failover", () => {
  it("switches to the configured fallback and emits a decision span", async () => {
    const verdict = {
      degraded: true,
      reason: "SigNoz error rate 75% over 8 calls",
      source: "signoz",
      detail: { errorRate: 0.75, samples: 8 },
    };
    getModelHealth.mockReturnValue(verdict);
    const { createModel } = await import("@/mastra/model");

    const model = createModel();

    expect(model).toMatchObject({ provider: "bedrock", id: "bedrock-model" });
    expect(emitFailoverSpan).toHaveBeenCalledWith({
      from: "fireworks",
      to: "bedrock",
      verdict,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps the primary when the fallback is not configured", async () => {
    delete process.env.BEDROCK_REGION;
    getModelHealth.mockReturnValue({
      degraded: true,
      reason: "local failures",
      source: "local",
      detail: {},
    });
    const { createModel } = await import("@/mastra/model");

    expect(createModel()).toMatchObject({ provider: "fireworks" });
    expect(emitFailoverSpan).not.toHaveBeenCalled();
  });

  it("fails open to the primary when health evaluation throws", async () => {
    getModelHealth.mockImplementation(() => {
      throw new Error("health backend broken");
    });
    const { createModel } = await import("@/mastra/model");

    expect(createModel()).toMatchObject({ provider: "fireworks" });
    expect(emitFailoverSpan).not.toHaveBeenCalled();
  });
});
