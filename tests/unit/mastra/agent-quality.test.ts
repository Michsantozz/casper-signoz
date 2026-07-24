import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Agent answer-QUALITY telemetry (src/mastra/agent-quality.ts).
 *
 * This is the third observability axis: cost and latency say what a turn spent
 * and whether it errored, neither says whether the answer was any GOOD. The
 * quality dashboard/alert in SigNoz are driven ENTIRELY by the eval span this
 * module emits, so the contract worth locking in is:
 *  - it is a pure side-effect: a scorer failure must never surface to the user
 *    and must never change the response path;
 *  - it is a no-op when SigNoz is off (don't spend CPU scoring into the void);
 *  - empty prompt/answer are skipped (the scorer would divide by zero);
 *  - when it DOES emit, the span carries the exact attribute names the dashboard
 *    filters on (mastra.span.type=eval, mastra.eval.scorer, mastra.eval.score) —
 *    renaming any of them silently blanks the quality panels.
 *
 * The scorer itself (@mastra/evals completeness) is mocked: we're testing the
 * telemetry contract, not someone else's NLP.
 */

const ORIGINAL_ENV = { ...process.env };
const scorerRun = vi.fn();

vi.mock("@mastra/evals/scorers/prebuilt", () => ({
  createCompletenessScorer: () => ({
    run: (...a: unknown[]) => scorerRun(...a),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  scorerRun.mockReset();
  scorerRun.mockResolvedValue({ score: 0.75 });
  delete process.env.SIGNOZ_ENDPOINT;
  delete process.env.SIGNOZ_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// Keep the OTel stack real (provider, tracer, span) and capture what actually
// gets emitted — mocking the tracer would prove nothing about the attributes.
async function loadWithCapturedSpans(activeSpan?: unknown) {
  const { InMemorySpanExporter } = await import("@opentelemetry/sdk-trace-base");
  const collector = new InMemorySpanExporter();

  // Let a test simulate Mastra's live agent span so an LLM span registers the
  // turn's trace ref (what the after() eval span later joins). Undefined by
  // default → no active span, same as the real no-Mastra-context case.
  vi.doMock("@mastra/core/observability/context-storage", () => ({
    getCurrentSpan: () => activeSpan,
  }));

  vi.doMock("@opentelemetry/exporter-trace-otlp-proto", () => ({
    OTLPTraceExporter: class {
      export(spans: unknown, cb: (r: unknown) => void) {
        return collector.export(spans as never, cb);
      }
      shutdown() {
        return collector.shutdown();
      }
      forceFlush() {
        return Promise.resolve();
      }
    },
  }));
  vi.doMock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
    OTLPMetricExporter: class {
      export(_m: unknown, cb: (r: unknown) => void) {
        cb({ code: 0 });
      }
      shutdown() {
        return Promise.resolve();
      }
      forceFlush() {
        return Promise.resolve();
      }
    },
  }));

  process.env.SIGNOZ_ENDPOINT = "http://localhost:4318/v1/traces";

  const quality = await import("@/mastra/agent-quality");
  const telemetry = await import("@/mastra/llm-telemetry");
  const flush = async () => {
    await telemetry.flushLlmTelemetry();
    return collector.getFinishedSpans();
  };
  return { quality, flush };
}

describe("scoreAgentTurn — no-op paths", () => {
  it("skips scoring entirely when SigNoz is off", async () => {
    const { scoreAgentTurn } = await import("@/mastra/agent-quality");
    await scoreAgentTurn({ promptText: "what broke?", answerText: "the db" });
    // No tracer → don't even spend the cycles running the scorer.
    expect(scorerRun).not.toHaveBeenCalled();
  });

  it("skips an empty prompt or answer (the scorer would divide by zero)", async () => {
    const { quality } = await loadWithCapturedSpans();
    await quality.scoreAgentTurn({ promptText: "   ", answerText: "hi" });
    await quality.scoreAgentTurn({ promptText: "hi", answerText: "" });
    expect(scorerRun).not.toHaveBeenCalled();
  });
});

describe("scoreAgentTurn — never breaks the response path", () => {
  it("swallows a scorer rejection instead of surfacing it", async () => {
    const { quality } = await loadWithCapturedSpans();
    scorerRun.mockRejectedValue(new Error("scorer exploded"));
    await expect(
      quality.scoreAgentTurn({ promptText: "q", answerText: "a" }),
    ).resolves.toBeUndefined();
  });

  it("emits nothing when the scorer returns a non-numeric score", async () => {
    const { quality, flush } = await loadWithCapturedSpans();
    scorerRun.mockResolvedValue({ score: undefined });
    await quality.scoreAgentTurn({ promptText: "q", answerText: "a" });
    const evals = (await flush()).filter((s) => s.name.startsWith("eval "));
    expect(evals).toHaveLength(0);
  });
});

describe("emitEvalSpan — the attributes the quality dashboard filters on", () => {
  it("emits one eval span carrying scorer + score", async () => {
    const { quality, flush } = await loadWithCapturedSpans();
    scorerRun.mockResolvedValue({ score: 0.42 });

    await quality.scoreAgentTurn({
      promptText: "why is latency up?",
      answerText: "a slow tool call",
    });

    const span = (await flush()).find((s) => s.name.startsWith("eval "));
    expect(span).toBeDefined();
    expect(span!.name).toBe("eval completeness");
    expect(span!.attributes["mastra.span.type"]).toBe("eval");
    expect(span!.attributes["mastra.eval.scorer"]).toBe("completeness");
    expect(span!.attributes["mastra.eval.score"]).toBe(0.42);
  });

  it("joins the turn's trace via the captured link (score lands in the waterfall)", async () => {
    // The eval span is scored in after(), when Mastra's own span context is gone.
    // A trace ref captured while the agent was live lets it join the SAME trace,
    // so a judge can click a bad turn and see its quality score in the waterfall.
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    // Active Mastra span → the turn's LLM span registers this ref in the holder.
    const { quality, flush } = await loadWithCapturedSpans({
      id: spanId,
      traceId,
      type: "agent_run",
      name: "agent",
    });
    const telemetry = await import("@/mastra/llm-telemetry");

    // Run the scoring inside a turn holder that the live LLM span populates,
    // exactly as a real chat turn would before after() scores it.
    await telemetry.runWithTurnTrace(async () => {
      // Drive a real LLM span through the holder so currentTurnLink() fills in.
      await telemetry.llmTelemetryMiddleware.wrapGenerate!({
        doGenerate: async () => ({
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          finishReason: "stop",
        }),
        model: { modelId: "m", provider: "p" },
      } as never);
      await quality.scoreAgentTurn({ promptText: "q", answerText: "a" });
    });

    const evalSpan = (await flush()).find((s) => s.name.startsWith("eval "));
    expect(evalSpan).toBeDefined();
    // Same trace as the turn's LLM span, parented under the captured ref.
    expect(evalSpan!.spanContext().traceId).toBe(traceId);
    expect(evalSpan!.parentSpanContext?.spanId).toBe(spanId);
  });

  it("passes the prompt and answer to the scorer as user/assistant messages", async () => {
    const { quality } = await loadWithCapturedSpans();
    await quality.scoreAgentTurn({
      promptText: "the question",
      answerText: "the answer",
    });

    const arg = scorerRun.mock.calls[0][0] as {
      input: { inputMessages: { role: string; content: { parts: unknown[] } }[] };
      output: { role: string; content: { parts: unknown[] } }[];
    };
    expect(arg.input.inputMessages[0].role).toBe("user");
    expect(arg.input.inputMessages[0].content.parts).toEqual([
      { type: "text", text: "the question" },
    ]);
    expect(arg.output[0].role).toBe("assistant");
    expect(arg.output[0].content.parts).toEqual([
      { type: "text", text: "the answer" },
    ]);
  });
});
