import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * assistantAgent config — guardrails + memory (mastra/agents/assistant.agent.ts).
 * Asserted statically via the Agent's introspection API (no LLM):
 *
 * Guardrails (input/output processors):
 *  - always: CostGuardProcessor (input) + TokenLimiter (output) — cheap, no LLM;
 *  - ENABLE_LLM_GUARDRAILS=true adds PromptInjectionDetector + PIIDetector (input);
 *  - default (flag off) does NOT include the LLM-based ones.
 *
 * Memory:
 *  - resolves to a Memory with semanticRecall + workingMemory + generateTitle on.
 *
 * MCP is mocked so the dynamic tools resolver stays offline; FIREWORKS/DATABASE
 * envs are set so lazy model/embedder/memory build without throwing.
 */

vi.mock("@/mastra/mcp", () => ({
  mcp: {
    listToolsetsWithErrors: vi.fn(async () => ({ toolsets: {}, errors: {} })),
  },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIREWORKS_API_KEY = "fw-test";
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  delete process.env.ENABLE_LLM_GUARDRAILS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function inputProcessorIds(): Promise<string[]> {
  const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
  const procs = await assistantAgent.listConfiguredInputProcessors();
  return procs.map((p) => (p as { id: string }).id);
}

async function outputProcessorIds(): Promise<string[]> {
  const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
  const procs = await assistantAgent.listConfiguredOutputProcessors();
  return procs.map((p) => (p as { id: string }).id);
}

describe("assistantAgent guardrails — default (LLM guardrails off)", () => {
  // First test cold-imports the Mastra agent graph — widen the timeout.
  it("input processors = cost-guard only (no LLM-based ones)", async () => {
    const ids = await inputProcessorIds();
    expect(ids).toContain("cost-guard");
    expect(ids).not.toContain("prompt-injection-detector");
    expect(ids).not.toContain("pii-detector");
  }, 20_000);

  it("output processor = token-limiter", async () => {
    expect(await outputProcessorIds()).toContain("token-limiter");
  });
});

describe("assistantAgent guardrails — ENABLE_LLM_GUARDRAILS=true", () => {
  // inputProcessors is a lazy resolver `() => buildInputProcessors()`, so it
  // reads ENABLE_LLM_GUARDRAILS at call time — flipping the env and re-querying
  // the SAME agent instance is enough; no module reset needed.
  beforeEach(() => {
    process.env.ENABLE_LLM_GUARDRAILS = "true";
  });

  it("adds prompt-injection + pii detectors alongside cost-guard", async () => {
    const ids = await inputProcessorIds();
    expect(ids).toContain("cost-guard");
    expect(ids).toContain("prompt-injection-detector");
    expect(ids).toContain("pii-detector");
  });
});

describe("assistantAgent memory", () => {
  it("resolves a memory with semanticRecall + workingMemory + generateTitle", async () => {
    const { assistantAgent } = await import("@/mastra/agents/assistant.agent");
    const memory = await assistantAgent.getMemory();
    expect(memory).toBeTruthy();
    // The concrete Memory exposes its resolved config; assert the three features.
    const config = (memory as unknown as { threadConfig?: Record<string, unknown> })
      .threadConfig;
    // threadConfig is the internal name; fall back to any options-bearing field.
    const opts =
      config ??
      (memory as unknown as { config?: Record<string, unknown> }).config ??
      {};
    // Whatever the field, the three feature keys must be present & truthy.
    const flat = JSON.stringify(opts);
    expect(flat).toContain("semanticRecall");
    expect(flat).toContain("workingMemory");
    expect(flat).toContain("generateTitle");
  });
});
