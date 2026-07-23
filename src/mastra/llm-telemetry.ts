import "server-only";

import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

// Self-instrumented LLM telemetry.
//
// WHY THIS EXISTS: the Mastra observability pipeline does NOT get token usage
// into SigNoz. Two independent gaps, both verified against the running stack:
//   1. @mastra/core (streaming path) never writes `usage` onto the
//      model_generation span's attributes — tokens live only on the generate()
//      return value, on no span.
//   2. @mastra/otel-exporter's converter only queues LEAF spans (processor_run,
//      model_chunk) — it converts but never enqueues the parent spans
//      (agent_run, model_generation), so they never reach the OTLP endpoint.
// Net effect: `gen_ai.usage.*` never lands in SigNoz, and the cost/token
// dashboards have no data source.
//
// FIX: wrap the language model with an AI SDK middleware that reads the REAL
// usage the provider returns and emits ONE clean OTLP CLIENT span per LLM call,
// on our own tracer, straight to SigNoz. This is independent of Mastra's broken
// export and covers every call that goes through the wrapped model (agent turns,
// tool sub-calls, and one-shot generateObject calls). No-op when SigNoz is off.

const SERVICE_NAME = "casper-assistant";

// Optional per-token pricing. Cost is emitted ONLY when both are configured —
// no placeholder ever ships as a real number. Values are USD per 1M tokens.
function pricePerToken(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const perMillion = Number(raw);
  if (!Number.isFinite(perMillion) || perMillion < 0) return undefined;
  return perMillion / 1_000_000;
}

let tracerProvider: BasicTracerProvider | undefined;

// Lazily build a dedicated tracer provider that ships to SigNoz over OTLP. We
// own this provider (not the global) so it can't collide with Mastra's exporter
// or Sentry's instrumentation. Returns undefined when SIGNOZ is not configured.
function getTracer() {
  const endpoint = process.env.SIGNOZ_ENDPOINT;
  if (!endpoint && !process.env.SIGNOZ_API_KEY) return undefined;

  if (!tracerProvider) {
    // SIGNOZ_ENDPOINT points at the traces path (…/v1/traces); the OTLP proto
    // exporter wants the same URL. Fall back to the local self-host default.
    const url = endpoint ?? "http://localhost:4318/v1/traces";
    const headers = process.env.SIGNOZ_API_KEY
      ? { "signoz-access-token": process.env.SIGNOZ_API_KEY }
      : undefined;

    tracerProvider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url, headers })),
      ],
    });
  }

  return tracerProvider.getTracer("casper.llm");
}

// Flush pending spans (call on graceful shutdown / after a one-shot script).
export async function flushLlmTelemetry() {
  await tracerProvider?.forceFlush().catch(() => {});
}

// Normalized token counts, flattened from the AI SDK v3 usage shape
// (`inputTokens: { total, noCache, cacheRead, cacheWrite }`, etc).
type TokenCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

// AI SDK v3 usage: token fields are objects, not numbers. Flatten to plain
// counts, tolerating a v2-style `{ inputTokens: number }` shape defensively.
function extractUsage(usage: unknown): TokenCounts {
  const u = usage as
    | {
        inputTokens?: number | { total?: number; cacheRead?: number };
        outputTokens?: number | { total?: number };
      }
    | null
    | undefined;
  if (!u) return {};
  const inRaw = u.inputTokens;
  const outRaw = u.outputTokens;
  const input = typeof inRaw === "number" ? inRaw : inRaw?.total;
  const output = typeof outRaw === "number" ? outRaw : outRaw?.total;
  const cacheRead =
    typeof inRaw === "number" ? undefined : inRaw?.cacheRead;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
  };
}

function emitLlmSpan(args: {
  modelId: string;
  provider: string;
  usage: unknown;
  durationMs: number;
  finishReason?: string;
  error?: unknown;
}) {
  const tracer = getTracer();
  if (!tracer) return;

  const { inputTokens, outputTokens, cacheReadTokens } = extractUsage(
    args.usage,
  );

  const priceIn = pricePerToken("LLM_PRICE_INPUT_PER_MTOK");
  const priceOut = pricePerToken("LLM_PRICE_OUTPUT_PER_MTOK");
  const cost =
    priceIn !== undefined &&
    priceOut !== undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined
      ? inputTokens * priceIn + outputTokens * priceOut
      : undefined;

  // Start the span in an empty context so it's a clean root (we don't have
  // Mastra's span context here). name mirrors the GenAI convention: "chat <model>".
  const span = tracer.startSpan(
    `chat ${args.modelId}`,
    { kind: SpanKind.CLIENT, startTime: new Date(Date.now() - args.durationMs) },
    context.active(),
  );

  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.request.model", args.modelId);
  span.setAttribute("gen_ai.provider.name", args.provider);
  // Discriminator our versioned SigNoz dashboards/alerts filter on. This IS a
  // model generation, so the label is accurate — it just also lets the existing
  // panels match without a schema change.
  span.setAttribute("mastra.span.type", "model_generation");
  if (inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
  }
  if (outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
  }
  if (cacheReadTokens !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", cacheReadTokens);
  }
  if (cost !== undefined) {
    // gen_ai.usage.cost is also what SigNoz's native LLM Observability reads.
    span.setAttribute("gen_ai.usage.cost", cost);
  }
  if (args.finishReason) {
    span.setAttribute(
      "gen_ai.response.finish_reasons",
      JSON.stringify([args.finishReason]),
    );
  }
  if (args.error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(
      "error.type",
      args.error instanceof Error ? args.error.name : "unknown",
    );
  }
  span.end();
}

// Read the provider name off the wrapped model (e.g. "openai", "amazon-bedrock").
function providerOf(model: { provider?: string }): string {
  return model.provider ?? "unknown";
}

// AI SDK middleware: wraps generate + stream, emits one LLM span per call with
// the REAL usage the provider returned. Pure side-effect around the call — it
// never changes params, output, or the stream itself.
export const llmTelemetryMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, model }) => {
    const started = Date.now();
    try {
      const result = await doGenerate();
      emitLlmSpan({
        modelId: model.modelId,
        provider: providerOf(model),
        usage: result.usage,
        durationMs: Date.now() - started,
        finishReason: String(result.finishReason),
      });
      return result;
    } catch (error) {
      emitLlmSpan({
        modelId: model.modelId,
        provider: providerOf(model),
        usage: null,
        durationMs: Date.now() - started,
        error,
      });
      throw error;
    }
  },

  wrapStream: async ({ doStream, model }) => {
    const started = Date.now();
    const { stream, ...rest } = await doStream();

    let usage: unknown;
    let finishReason: string | undefined;

    // Tap the stream to capture the terminal usage without altering it. The AI
    // SDK emits a "finish" part carrying usage + finishReason at stream end.
    const tapped = stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (chunk?.type === "finish") {
            usage = chunk.usage;
            finishReason = String(chunk.finishReason);
          }
          controller.enqueue(chunk);
        },
        flush() {
          emitLlmSpan({
            modelId: model.modelId,
            provider: providerOf(model),
            usage,
            durationMs: Date.now() - started,
            finishReason,
          });
        },
      }),
    );

    return { stream: tapped, ...rest };
  },
};

// Wrap any AI SDK LanguageModel with the telemetry middleware. Identity-ish:
// returns a model that behaves the same but emits a span per call.
export function withLlmTelemetry<M extends Parameters<typeof wrapLanguageModel>[0]["model"]>(
  model: M,
) {
  return wrapLanguageModel({ model, middleware: llmTelemetryMiddleware });
}

// ════════════════════════════════════════════════════════════════════════
// Tool-call telemetry
// ════════════════════════════════════════════════════════════════════════
//
// Same rationale as the LLM span: Mastra's exporter never lands a queryable
// tool_call span in SigNoz (it only enqueues leaf model_chunk/processor_run
// spans). We emit our own so the "Tool calls" panels + the tool-failures alert
// have a real data source. One CLIENT span per tool execution, carrying the
// tool name, duration, and error.type on failure.
function emitToolSpan(args: {
  toolName: string;
  durationMs: number;
  error?: unknown;
}) {
  const tracer = getTracer();
  if (!tracer) return;

  const span = tracer.startSpan(
    `execute_tool ${args.toolName}`,
    { kind: SpanKind.CLIENT, startTime: new Date(Date.now() - args.durationMs) },
    context.active(),
  );

  span.setAttribute("gen_ai.operation.name", "execute_tool");
  span.setAttribute("gen_ai.tool.name", args.toolName);
  // Discriminator our versioned SigNoz dashboards/alerts filter on.
  span.setAttribute("mastra.span.type", "tool_call");
  if (args.error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(
      "error.type",
      args.error instanceof Error ? args.error.name : "unknown",
    );
  }
  span.end();
}

// A Mastra tool: the only field we touch is `execute`, whose signature we keep
// intact by inference. `id` names the span.
type ExecutableTool = { id?: string; execute?: (...a: never[]) => unknown };

// Wrap a single Mastra tool so each execution emits a tool_call span. Preserves
// the tool object (schemas, description, id) and the exact execute signature —
// only side-effects a span around the call, never changes input or output.
export function withToolTelemetry<T extends ExecutableTool>(
  tool: T,
  name?: string,
): T {
  if (typeof tool.execute !== "function") return tool;
  const toolName = name ?? tool.id ?? "unknown";
  const original = tool.execute.bind(tool) as (...a: never[]) => unknown;

  const wrapped = async (...callArgs: never[]) => {
    const started = Date.now();
    try {
      const result = await original(...callArgs);
      emitToolSpan({ toolName, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      emitToolSpan({ toolName, durationMs: Date.now() - started, error });
      throw error;
    }
  };

  return { ...tool, execute: wrapped } as T;
}

// Wrap every tool in an agent's toolset map. The map KEY is the exposed tool
// name (what the model calls), so we use it as the span's tool name — keeping
// dashboard labels aligned with what the LLM sees.
export function wrapToolset<M extends Record<string, ExecutableTool>>(
  toolset: M,
): M {
  const out: Record<string, ExecutableTool> = {};
  for (const [name, tool] of Object.entries(toolset)) {
    out[name] = withToolTelemetry(tool, name);
  }
  return out as M;
}
