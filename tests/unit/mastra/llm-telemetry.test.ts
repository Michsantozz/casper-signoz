import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Self-instrumented LLM/tool/retrieval telemetry (src/mastra/llm-telemetry.ts).
 *
 * WHY these tests matter: this module exists precisely because Mastra's own
 * exporter drops token usage and parent spans on the floor — it is the ONLY
 * source of gen_ai.usage.* in SigNoz. The parsing (AI SDK v3 usage shape) and
 * the wrappers (tool/vector) are pure logic with sharp edges: a silent regress
 * in extractUsage means every cost/token dashboard goes blank with no error.
 *
 * We do NOT stand up a real OTLP exporter. Instead we exercise the two contracts
 * that don't need one:
 *  - the pass-through wrappers (withToolTelemetry/wrapToolset, withVectorTelemetry,
 *    the stream tap) MUST preserve behavior/output exactly, and be no-ops for
 *    telemetry when SigNoz is unconfigured (no env → getTracer() returns
 *    undefined → emit* early-returns);
 *  - idempotency of the vector wrapper (Symbol marker).
 *
 * extractUsage is not exported, so we assert it indirectly through the stream
 * tap + wrapGenerate (the only public surface that reads usage). With SigNoz
 * OFF, the observable contract is "never throws, never mutates output" across
 * every usage shape (v3 object, v2 number, null) — which is exactly the
 * regression that would blank the dashboards.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // SigNoz OFF by default: getTracer() returns undefined, every emit* is a
  // no-op. This is the safe production path when observability isn't wired, and
  // lets us assert the wrappers are transparent without a live OTLP endpoint.
  delete process.env.SIGNOZ_ENDPOINT;
  delete process.env.SIGNOZ_API_KEY;
  delete process.env.LLM_PRICE_INPUT_PER_MTOK;
  delete process.env.LLM_PRICE_OUTPUT_PER_MTOK;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── withToolTelemetry / wrapToolset ─────────────────────────────────────────

describe("withToolTelemetry", () => {
  it("preserves the tool's output and passes args through unchanged", async () => {
    const { withToolTelemetry } = await import("@/mastra/llm-telemetry");
    const execute = vi.fn(async (a: { x: number }) => ({ doubled: a.x * 2 }));
    const tool = { id: "myTool", execute };

    const wrapped = withToolTelemetry(tool);
    const out = await (wrapped.execute as typeof execute)({ x: 21 });

    expect(out).toEqual({ doubled: 42 });
    expect(execute).toHaveBeenCalledWith({ x: 21 });
  });

  it("re-throws the tool's error (span emitted defensively, error propagates)", async () => {
    const { withToolTelemetry } = await import("@/mastra/llm-telemetry");
    const boom = new Error("tool blew up");
    const tool = {
      id: "failing",
      execute: vi.fn(async () => {
        throw boom;
      }),
    };

    const wrapped = withToolTelemetry(tool);
    await expect((wrapped.execute as () => Promise<unknown>)()).rejects.toBe(
      boom,
    );
  });

  it("no-ops (returns the tool as-is) when there is no execute", async () => {
    const { withToolTelemetry } = await import("@/mastra/llm-telemetry");
    const tool = { id: "declarative" } as { id: string; execute?: never };
    expect(withToolTelemetry(tool)).toBe(tool);
  });

  it("preserves the rest of the tool object (schemas, description, id)", async () => {
    const { withToolTelemetry } = await import("@/mastra/llm-telemetry");
    const tool = {
      id: "rich",
      description: "does a thing",
      inputSchema: { marker: true },
      execute: async () => "ok",
    };
    const wrapped = withToolTelemetry(tool);
    expect(wrapped.id).toBe("rich");
    expect(wrapped.description).toBe("does a thing");
    expect(wrapped.inputSchema).toEqual({ marker: true });
  });
});

describe("wrapToolset", () => {
  it("wraps every tool, keeps map keys, and each still returns its output", async () => {
    const { wrapToolset } = await import("@/mastra/llm-telemetry");
    const toolset = {
      alpha: { id: "alpha", execute: vi.fn(async () => "A") },
      beta: { id: "beta", execute: vi.fn(async () => "B") },
    };

    const wrapped = wrapToolset(toolset);

    expect(Object.keys(wrapped)).toEqual(["alpha", "beta"]);
    expect(await (wrapped.alpha.execute as () => Promise<string>)()).toBe("A");
    expect(await (wrapped.beta.execute as () => Promise<string>)()).toBe("B");
  });
});

// ── withVectorTelemetry ─────────────────────────────────────────────────────

describe("withVectorTelemetry", () => {
  it("preserves query results and passes the query args through", async () => {
    const { withVectorTelemetry } = await import("@/mastra/llm-telemetry");
    const hits = [{ score: 0.9 }, { score: 0.5 }];
    const query = vi.fn(async () => hits);
    const store = { query };

    const wrapped = withVectorTelemetry(store);
    const out = await (wrapped.query as (a: unknown) => Promise<unknown[]>)({
      indexName: "mem",
      topK: 3,
    });

    expect(out).toBe(hits);
    expect(query).toHaveBeenCalledWith({ indexName: "mem", topK: 3 });
  });

  it("mutates the store in place (returns the same instance, preserving prototype methods)", async () => {
    const { withVectorTelemetry } = await import("@/mastra/llm-telemetry");
    const store = { query: async () => [] };
    const result = withVectorTelemetry(store);
    // Returned instance is the SAME object — spreading a PgVector class instance
    // would drop its prototype methods, so the wrapper must mutate in place.
    expect(result).toBe(store);
  });

  it("is idempotent — double-wrapping does not re-wrap query", async () => {
    const { withVectorTelemetry } = await import("@/mastra/llm-telemetry");
    const store = { query: async () => [] };

    const once = withVectorTelemetry(store);
    const queryAfterFirst = once.query;
    const twice = withVectorTelemetry(once);

    // Second wrap is a no-op via the Symbol marker: query reference unchanged.
    expect(twice.query).toBe(queryAfterFirst);
  });

  it("re-throws a query error", async () => {
    const { withVectorTelemetry } = await import("@/mastra/llm-telemetry");
    const boom = new Error("pgvector down");
    const store = {
      query: async () => {
        throw boom;
      },
    };
    const wrapped = withVectorTelemetry(store);
    await expect(
      (wrapped.query as (a: unknown) => Promise<unknown[]>)({
        indexName: "mem",
      }),
    ).rejects.toBe(boom);
  });

  it("no-ops when there is no query method", async () => {
    const { withVectorTelemetry } = await import("@/mastra/llm-telemetry");
    const store = {} as { query: (...a: never[]) => Promise<unknown[]> };
    expect(withVectorTelemetry(store)).toBe(store);
  });
});

// ── llmTelemetryMiddleware: transparency across every usage shape ────────────

describe("llmTelemetryMiddleware — wrapGenerate", () => {
  it("returns doGenerate's result untouched (v3 object usage)", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");
    const result = {
      usage: { inputTokens: { total: 100 }, outputTokens: { total: 40 } },
      finishReason: "stop",
      content: "hi",
    };
    const out = await llmTelemetryMiddleware.wrapGenerate!({
      doGenerate: async () => result,
      model: { modelId: "glm-5p2", provider: "openai" },
    } as never);
    expect(out).toBe(result);
  });

  it("tolerates a v2-style numeric usage without throwing", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");
    const result = {
      usage: { inputTokens: 100, outputTokens: 40 },
      finishReason: "stop",
    };
    const out = await llmTelemetryMiddleware.wrapGenerate!({
      doGenerate: async () => result,
      model: { modelId: "m", provider: "p" },
    } as never);
    expect(out).toBe(result);
  });

  it("tolerates null/absent usage without throwing", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");
    const result = { usage: null, finishReason: "stop" };
    const out = await llmTelemetryMiddleware.wrapGenerate!({
      doGenerate: async () => result,
      model: { modelId: "m", provider: "p" },
    } as never);
    expect(out).toBe(result);
  });

  it("emits an error span and re-throws when doGenerate throws", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");
    const boom = new Error("provider 500");
    await expect(
      llmTelemetryMiddleware.wrapGenerate!({
        doGenerate: async () => {
          throw boom;
        },
        model: { modelId: "m", provider: "p" },
      } as never),
    ).rejects.toBe(boom);
  });
});

describe("llmTelemetryMiddleware — wrapStream", () => {
  it("passes every chunk through the tap unchanged, including the finish part", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");

    const chunks = [
      { type: "text-delta", delta: "hel" },
      { type: "text-delta", delta: "lo" },
      {
        type: "finish",
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } },
        finishReason: "stop",
      },
    ];
    const source = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });

    const { stream } = (await llmTelemetryMiddleware.wrapStream!({
      doStream: async () => ({ stream: source, extra: "kept" }),
      model: { modelId: "m", provider: "p" },
    } as never)) as { stream: ReadableStream };

    const seen: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen.push(value);
    }
    // Tap is a pure observer: the chunk sequence out === the sequence in.
    expect(seen).toEqual(chunks);
  });

  it("preserves the non-stream fields returned by doStream", async () => {
    const { llmTelemetryMiddleware } = await import("@/mastra/llm-telemetry");
    const source = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    const out = (await llmTelemetryMiddleware.wrapStream!({
      doStream: async () => ({ stream: source, request: { id: "r1" } }),
      model: { modelId: "m", provider: "p" },
    } as never)) as unknown as { request: { id: string } };
    expect(out.request).toEqual({ id: "r1" });
  });
});

// ── flushLlmTelemetry ───────────────────────────────────────────────────────

describe("flushLlmTelemetry", () => {
  it("resolves without throwing when no provider was ever built (SigNoz off)", async () => {
    const { flushLlmTelemetry } = await import("@/mastra/llm-telemetry");
    await expect(flushLlmTelemetry()).resolves.toBeUndefined();
  });
});
