import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type AttributeValue,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
} from "@opentelemetry/api";
import {
  logs,
  SeverityNumber,
  type Logger as OtelLogger,
} from "@opentelemetry/api-logs";
import { getCurrentSpan } from "@mastra/core/observability/context-storage";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
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

// ── OTel resource ───────────────────────────────────────────────────────────
//
// Every span/metric carries these. service.name alone is not enough to operate
// the stack: without deployment.environment.name a staging run and a prod run
// are INDISTINGUISHABLE in SigNoz (same service, same metrics, silently mixed
// time series), and without service.instance.id you can't tell one replica's
// spike from a fleet-wide one. Both are OTel semconv-standard, so SigNoz's
// resource filters pick them up with no extra config.
const DEPLOY_ENV =
  process.env.DEPLOYMENT_ENVIRONMENT ??
  process.env.VERCEL_ENV ??
  process.env.NODE_ENV ??
  "development";

// Stable for the life of the process, unique per replica. Prefer the platform's
// own instance id when it exposes one, else a random uuid at module load.
const INSTANCE_ID =
  process.env.HOSTNAME ?? process.env.VERCEL_DEPLOYMENT_ID ?? crypto.randomUUID();

function signozResource() {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    [ATTR_SERVICE_NAMESPACE]: "casperagent",
    [ATTR_SERVICE_INSTANCE_ID]: INSTANCE_ID,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: DEPLOY_ENV,
  });
}

// ── OTLP endpoint resolution ────────────────────────────────────────────────
//
// SIGNOZ_ENDPOINT is documented as the TRACES url (…/v1/traces), and the metrics
// exporter needs …/v1/metrics on the same collector. Deriving that by string
// replace is a silent-failure trap: an endpoint without the /v1/traces suffix
// (a bare collector root, or a proxy path) passes the replace untouched and
// metrics get POSTed to the traces path — the collector 404s/ignores them and
// the metric panels stay empty with no error anywhere. Parse the URL instead and
// rewrite the SIGNAL SEGMENT explicitly, so any shape resolves correctly.
function otlpEndpoint(signal: "traces" | "metrics" | "logs"): string {
  const raw = process.env.SIGNOZ_ENDPOINT;
  if (!raw) return `http://localhost:4318/v1/${signal}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a parseable URL — env validation warns at boot; fall back to local so
    // we never throw on the telemetry path.
    return `http://localhost:4318/v1/${signal}`;
  }

  // Strip a trailing signal segment (traces|metrics|logs), with or without the
  // /v1 prefix, then re-append the one we want. Handles: …/v1/traces, …/v1/,
  // …/ (collector root), and …/proxy/otlp/v1/traces alike.
  const path = url.pathname.replace(/\/+$/, "");
  const base = path.replace(/(\/v1)?\/(traces|metrics|logs)$/, "");
  url.pathname = `${base}/v1/${signal}`;
  return url.toString();
}

// Optional per-token pricing. Cost is emitted ONLY when both are configured —
// no placeholder ever ships as a real number. Values are USD per 1M tokens.
function pricePerToken(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  const perMillion = Number(raw);
  if (!Number.isFinite(perMillion) || perMillion < 0) return undefined;
  return perMillion / 1_000_000;
}

// Coerce a provider's finishReason into the plain string semconv expects
// ("stop", "length", "tool_calls", …). Most providers give a string; some
// (observed: Fireworks kimi-k2 via the AI SDK) return an OBJECT, and a bare
// String() on it ships the literal "[object Object]" — which is exactly what
// then landed in gen_ai.response.finish_reasons for 78% of real spans, making
// the attribute unfilterable. Unwrap the common object shapes before stringifying
// so the finish-reason panels/filters see a real value.
function finishReasonText(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const field = o.type ?? o.reason ?? o.finishReason ?? o.value;
    if (typeof field === "string") return field;
    // Unknown object shape: preserve the payload as JSON rather than lose it to
    // "[object Object]", so it stays inspectable even if not cleanly filterable.
    try {
      return JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return String(raw);
}

let tracerProvider: BasicTracerProvider | undefined;

// Lazily build a dedicated tracer provider that ships to SigNoz over OTLP. We
// own this provider (not the global) so it can't collide with Mastra's exporter
// or Sentry's instrumentation. Returns undefined when SIGNOZ is not configured.
// Exported so sibling instrumentation (agent-quality.ts) shares the same OTLP
// provider/flush instead of standing up a second one.
export function getSignozTracer() {
  const endpoint = process.env.SIGNOZ_ENDPOINT;
  if (!endpoint && !process.env.SIGNOZ_API_KEY) return undefined;

  if (!tracerProvider) {
    // SIGNOZ_ENDPOINT points at the traces path (…/v1/traces); normalize it so a
    // collector root or a proxied path resolves to the traces signal too.
    const url = otlpEndpoint("traces");
    const headers = process.env.SIGNOZ_API_KEY
      ? { "signoz-access-token": process.env.SIGNOZ_API_KEY }
      : undefined;

    tracerProvider = new BasicTracerProvider({
      resource: signozResource(),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url, headers })),
      ],
    });
  }

  return tracerProvider.getTracer("casper.llm");
}

// ────────────────────────────────────────────────────────────────────────
// Metrics pipeline (OTLP) — the fifth SigNoz signal.
//
// WHY: Mastra's OtelExporter forwards only TRACES + LOGS (it has no
// onMetricEvent), so token/cost/latency reach SigNoz solely as span attributes.
// That works for trace-derived dashboards but leaves SigNoz's native *metrics*
// store empty — no first-class time series to build Query-Builder metric panels,
// PromQL, or metric-based alerts on. This adds a dedicated OTLP MeterProvider
// (twin of the tracer above) so the same numbers ALSO land as real OTel metrics:
//   - gen_ai.client.token.usage      (Counter, by model/provider/token type)
//   - gen_ai.client.operation.cost   (Counter, USD, by model/provider)
//   - gen_ai.client.operation.duration (Histogram, seconds, by op/model/tool)
// Emitted alongside every span, so metrics and traces stay in lock-step. Same
// env toggle as the tracer — no-op when SigNoz is unconfigured.
// ────────────────────────────────────────────────────────────────────────

let meterProvider: MeterProvider | undefined;
let instruments:
  | {
      tokens: Counter;
      cost: Counter;
      duration: Histogram;
    }
  | undefined;

function getSignozMeter(): Meter | undefined {
  if (!process.env.SIGNOZ_ENDPOINT && !process.env.SIGNOZ_API_KEY) {
    return undefined;
  }

  if (!meterProvider) {
    const headers = process.env.SIGNOZ_API_KEY
      ? { "signoz-access-token": process.env.SIGNOZ_API_KEY }
      : undefined;

    meterProvider = new MeterProvider({
      resource: signozResource(),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: otlpEndpoint("metrics"),
            headers,
          }),
          // Ship every 10s so metric panels track a live demo closely.
          exportIntervalMillis: 10_000,
        }),
      ],
    });
    // Register globally too, so any OTel-aware library metric rides the same
    // provider instead of standing up a second (never-flushed) one.
    metrics.setGlobalMeterProvider(meterProvider);
  }

  return meterProvider.getMeter("casper.llm");
}

// Build the instruments once (idempotent). Counters/Histogram share the meter.
function getInstruments() {
  if (instruments) return instruments;
  const meter = getSignozMeter();
  if (!meter) return undefined;
  instruments = {
    // Follows the OTel GenAI metric semconv names so SigNoz's native metric
    // views recognize them.
    tokens: meter.createCounter("gen_ai.client.token.usage", {
      description: "LLM tokens consumed, by model/provider/token type",
      unit: "{token}",
    }),
    cost: meter.createCounter("gen_ai.client.operation.cost", {
      description: "LLM call cost in USD (only when pricing is configured)",
      unit: "USD",
    }),
    duration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "Duration of a GenAI operation (LLM / tool / retrieval)",
      unit: "s",
      // The SDK's default boundaries top out at 10_000 — sane for MILLISECONDS,
      // useless here: this instrument records SECONDS, so every real LLM call
      // (0.5s–60s) lands in the first two buckets and p95/p99 collapse to a
      // meaningless "somewhere under 10s". These are the OTel GenAI semconv
      // recommended boundaries for gen_ai.client.operation.duration — they give
      // real resolution across the sub-second tool call and the 40s streamed
      // completion alike.
      advice: {
        explicitBucketBoundaries: [
          0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
          20.48, 40.96, 81.92,
        ],
      },
    }),
  };
  return instruments;
}

// ────────────────────────────────────────────────────────────────────────
// Logs pipeline (OTLP) — the SIXTH-signal completer, but really the one that
// makes SigNoz's "correlate signals" story land: a first-class LOG record for
// each failure, stamped with the SAME traceId/spanId as the error span.
//
// WHY: Mastra's OtelExporter forwards logs only from ITS OWN internal log events
// (onLogEvent) — sparse, uncorrelated to our self-instrumented LLM/tool/retrieval
// spans, and driven by whatever Mastra decides to log. So the Logs tab in SigNoz
// stayed effectively empty and no dashboard/alert read the logs signal. This adds
// a dedicated OTLP LoggerProvider (twin of the tracer + meter above) and emits ONE
// correlated ERROR log per failure at the exact point we already emit the error
// span. The log carries the failing span's trace context (via LogRecord.context →
// the SDK stamps traceId+spanId), so in SigNoz you click a log line and jump
// straight to the failing span in the trace waterfall — cross-signal correlation,
// not just "logs also exist". Same env toggle as tracer/meter; no-op when SigNoz
// is unconfigured.
// ────────────────────────────────────────────────────────────────────────

let loggerProvider: LoggerProvider | undefined;

function getSignozLogger(): OtelLogger | undefined {
  if (!process.env.SIGNOZ_ENDPOINT && !process.env.SIGNOZ_API_KEY) {
    return undefined;
  }

  if (!loggerProvider) {
    const headers = process.env.SIGNOZ_API_KEY
      ? { "signoz-access-token": process.env.SIGNOZ_API_KEY }
      : undefined;

    loggerProvider = new LoggerProvider({
      resource: signozResource(),
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({ url: otlpEndpoint("logs"), headers }),
        ),
      ],
    });
    // Register globally so any OTel-aware library log rides the same provider
    // instead of standing up a second (never-flushed) one.
    logs.setGlobalLoggerProvider(loggerProvider);
  }

  return loggerProvider.getLogger("casper.llm");
}

// Emit ONE correlated OTLP ERROR log for a failure. The whole point is the
// `context`: passing the error span stamps this record with that span's exact
// traceId+spanId (the SDK reads LogRecord.context → trace.getSpanContext), so the
// log line links back to the precise failing span in the waterfall. Falls back to
// Mastra's active-span context when no span is handed in. No-op when SigNoz is off;
// never throws (a telemetry failure must never break the request path).
function emitErrorLog(args: {
  operation: string;
  body: string;
  error: unknown;
  span?: Span;
  attributes?: Record<string, AttributeValue>;
}) {
  try {
    const logger = getSignozLogger();
    if (!logger) return;

    const errType = args.error instanceof Error ? args.error.name : "unknown";
    const errMsg =
      args.error instanceof Error ? args.error.message : String(args.error);

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      body: args.body,
      attributes: {
        "gen_ai.operation.name": args.operation,
        // Bounded label set, same discipline as the metric error label, so the
        // logs-by-type panel/alert group on a closed set.
        "error.type": errorMetricLabel(args.error),
        // OTel exception semconv — SigNoz's log view renders these specially.
        "exception.type": errType,
        "exception.message": errMsg,
        ...args.attributes,
      },
      // Correlate to the SAME trace/span as the error span. When we have the
      // span, use its context so the log's spanId === the failing span's spanId
      // (click the log → land on that exact span). Else fall back to Mastra's
      // active agent span so the log at least joins the turn's trace.
      context: args.span
        ? trace.setSpan(context.active(), args.span)
        : mastraParentContext(),
    });
  } catch {
    // Best-effort: never let a logging failure escape onto the request path.
  }
}

// Flush pending spans + metrics + logs (call on graceful shutdown / after a
// one-shot script). Forces each provider to export before exit.
export async function flushLlmTelemetry() {
  await tracerProvider?.forceFlush().catch(() => {});
  await meterProvider?.forceFlush().catch(() => {});
  await loggerProvider?.forceFlush().catch(() => {});
}

// ── Shutdown flush ──────────────────────────────────────────────────────────
//
// BatchSpanProcessor buffers spans and the metric reader exports on a 10s tick,
// so on SIGTERM (every container stop, rolling deploy, scale-down) whatever
// hasn't shipped yet dies with the process — precisely the telemetry of the
// final requests, which is when things usually went wrong. Flush on the way out.
//
// Registered once per PROCESS, not per module instance. A module-level boolean
// is not enough: Next's dev hot-reload and Vitest's per-file module registry
// each re-evaluate this file, so a local guard still stacks one listener set per
// evaluation (MaxListenersExceededWarning at 11, then an unbounded leak). Park
// the flag on a process-level Symbol so every copy of the module shares it.
const SHUTDOWN_HOOKED = Symbol.for("casper.llmTelemetry.shutdownHooked");

function registerShutdownFlush() {
  if (typeof process === "undefined") return;
  const marked = process as unknown as Record<symbol, boolean | undefined>;
  if (marked[SHUTDOWN_HOOKED]) return;
  marked[SHUTDOWN_HOOKED] = true;

  let flushing = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (flushing) return;
    flushing = true;
    // Best-effort and bounded: never hold a shutdown hostage to a hung
    // collector. Re-raise the signal afterwards so the default disposition
    // (exit) still applies — we only borrow the moment before it.
    const bounded = Promise.race([
      flushLlmTelemetry(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    void bounded.finally(() => {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  };

  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // beforeExit fires on a natural drain (one-shot scripts, cron ticks) where no
  // signal is ever delivered. Safe to await here — the loop is still alive.
  process.on("beforeExit", () => {
    void flushLlmTelemetry();
  });
}

registerShutdownFlush();

// Normalized token counts, flattened from the AI SDK v3 usage shape
// (`inputTokens: { total, noCache, cacheRead, cacheWrite }`, etc).
type TokenCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

// AI SDK v3 usage: token fields are objects, not numbers. Flatten to plain
// counts, tolerating a v2-style `{ inputTokens: number }` shape defensively.
function extractUsage(usage: unknown): TokenCounts {
  const u = usage as
    | {
        inputTokens?:
          | number
          | { total?: number; cacheRead?: number; cacheWrite?: number };
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
  // Cache-WRITE (a.k.a. cache-creation) tokens: what it cost to populate the
  // prompt cache this call. Distinct from cacheRead. Anthropic reports it
  // separately; maps to gen_ai.usage.cache_creation.input_tokens.
  const cacheWrite =
    typeof inRaw === "number" ? undefined : inRaw?.cacheWrite;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

function emitLlmSpan(args: {
  modelId: string;
  provider: string;
  usage: unknown;
  durationMs: number;
  finishReason?: string;
  // Time-to-first-token in ms (streaming only). Feeds SigNoz's native AI
  // Observability "TTFT p95" panel (gen_ai.server.ttft).
  ttftMs?: number;
  error?: unknown;
}) {
  const tracer = getSignozTracer();
  if (!tracer) return;

  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
    extractUsage(args.usage);

  const priceIn = pricePerToken("LLM_PRICE_INPUT_PER_MTOK");
  const priceOut = pricePerToken("LLM_PRICE_OUTPUT_PER_MTOK");
  // Cache tokens are priced DIFFERENTLY from fresh input: providers bill
  // cache-read at a fraction of input (~0.1x on Anthropic) and cache-write at a
  // premium (~1.25x). Optional — when unset, each falls back to the plain input
  // price (previous behavior), so cost is never fabricated from a missing env.
  const priceCacheRead =
    pricePerToken("LLM_PRICE_CACHE_READ_PER_MTOK") ?? priceIn;
  const priceCacheWrite =
    pricePerToken("LLM_PRICE_CACHE_WRITE_PER_MTOK") ?? priceIn;
  // AI SDK v3 reports inputTokens.total INCLUSIVE of cache read+write. Pricing
  // the whole total at the input rate double-charges cache the wrong way (see
  // above). Split it: fresh input at priceIn, each cache class at its own rate.
  const cost =
    priceIn !== undefined &&
    priceOut !== undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined
      ? (() => {
          const cacheRead = cacheReadTokens ?? 0;
          const cacheWrite = cacheWriteTokens ?? 0;
          // Never let rounding/reporting quirks make fresh input negative.
          const freshInput = Math.max(0, inputTokens - cacheRead - cacheWrite);
          return (
            freshInput * priceIn +
            cacheRead * (priceCacheRead ?? priceIn) +
            cacheWrite * (priceCacheWrite ?? priceIn) +
            outputTokens * priceOut
          );
        })()
      : undefined;

  // Start the span in an empty context so it's a clean root (we don't have
  // Mastra's span context here). name mirrors the GenAI convention: "chat <model>".
  const span = tracer.startSpan(
    `chat ${args.modelId}`,
    { kind: SpanKind.CLIENT, startTime: new Date(Date.now() - args.durationMs) },
    // Parent under Mastra's active agent span so this LLM call joins the E2E
    // trace instead of standing up its own root.
    mastraParentContext(),
  );

  span.setAttribute("gen_ai.operation.name", "chat");
  span.setAttribute("gen_ai.request.model", args.modelId);
  span.setAttribute("gen_ai.provider.name", args.provider);
  // Legacy GenAI-semconv alias for the provider. SigNoz's built-in "AI
  // Observability" dashboard identifies an LLM span by `gen_ai.system != ''`
  // (not by the newer gen_ai.provider.name), so emitting both makes these spans
  // ALSO light up SigNoz's native AI panels — on top of our own mastra.span.type
  // dashboards. Purely additive; same value as gen_ai.provider.name.
  span.setAttribute("gen_ai.system", args.provider);
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
  if (cacheWriteTokens !== undefined) {
    // Cache-creation tokens. Canonical GenAI-semconv name SigNoz's native LLM
    // pricing (EE) + AI dashboards read for cache-write cost accounting.
    span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      cacheWriteTokens,
    );
  }
  if (cost !== undefined) {
    // gen_ai.usage.cost is also what SigNoz's native LLM Observability reads.
    span.setAttribute("gen_ai.usage.cost", cost);
  }
  // Time-to-first-token: how long until the model emitted its first content
  // chunk. Streaming only — the native SigNoz AI dashboard p95's gen_ai.server.ttft.
  if (args.ttftMs !== undefined) {
    span.setAttribute("gen_ai.server.ttft", args.ttftMs / 1000);
  }
  if (args.finishReason) {
    // Semconv says this is an ARRAY attribute. Passing a JSON *string* ships
    // the literal `["stop"]`, which SigNoz indexes as an opaque string — you
    // can't filter `= 'stop'`, only substring-match the serialized form. OTel
    // supports string[] natively; emit it as one so the query builder groups
    // and filters on the real value.
    span.setAttribute("gen_ai.response.finish_reasons", [args.finishReason]);
  }
  if (args.error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    const errType = args.error instanceof Error ? args.error.name : "unknown";
    span.setAttribute("error.type", errType);
    // GenAI-semconv error attribute — the native SigNoz AI dashboard groups its
    // error panel by gen_ai.error.type. Same value as error.type; additive.
    span.setAttribute("gen_ai.error.type", errType);
    // Correlated ERROR log: same trace/span as this failing LLM span, so the
    // Logs tab links back to the exact call in the waterfall.
    emitErrorLog({
      operation: "chat",
      body: `LLM call failed: ${args.modelId} (${errType})`,
      error: args.error,
      span,
      attributes: {
        "gen_ai.request.model": args.modelId,
        "gen_ai.provider.name": args.provider,
      },
    });
  }
  span.end();

  // Mirror the same numbers as first-class OTel metrics (fifth SigNoz signal).
  // Labels stay low-cardinality (model/provider/type) so metric series don't
  // explode. No-op when SigNoz is off.
  const inst = getInstruments();
  if (inst) {
    const base = {
      "gen_ai.request.model": args.modelId,
      "gen_ai.provider.name": args.provider,
    };
    if (inputTokens !== undefined) {
      inst.tokens.add(inputTokens, { ...base, "gen_ai.token.type": "input" });
    }
    if (outputTokens !== undefined) {
      inst.tokens.add(outputTokens, { ...base, "gen_ai.token.type": "output" });
    }
    if (cacheReadTokens !== undefined) {
      inst.tokens.add(cacheReadTokens, {
        ...base,
        "gen_ai.token.type": "cache_read",
      });
    }
    if (cacheWriteTokens !== undefined) {
      inst.tokens.add(cacheWriteTokens, {
        ...base,
        "gen_ai.token.type": "cache_write",
      });
    }
    if (cost !== undefined) inst.cost.add(cost, base);
    inst.duration.record(args.durationMs / 1000, {
      ...base,
      "gen_ai.operation.name": "chat",
      // Bounded error label — same discipline as the tool/retrieval duration
      // metrics. Without it a failed call (fast 401 / slow timeout) lands in the
      // SAME histogram as successes, silently skewing the p95 latency panel with
      // no way to filter. "none" on the success path keeps the series stable.
      "error.type": errorMetricLabel(args.error),
    });
  }
}

// Read the provider name off the wrapped model (e.g. "openai", "amazon-bedrock").
function providerOf(model: { provider?: string }): string {
  return model.provider ?? "unknown";
}

// Bounded error-type LABEL for METRICS. On a span an error.type can be any
// error.name — that's fine, it's an attribute. But as a metric label it joins
// the series key, and an unbounded/dynamic error name (e.g. one that embeds an
// id) would explode the time-series cardinality. So on the metric path we map to
// a small closed set and bucket anything unexpected as "other". Spans keep the
// raw name; only the metric label is clamped.
const KNOWN_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "RateLimitError",
  "APICallError",
  "APIError",
  "AuthenticationError",
  "PermissionError",
  "NotFoundError",
  "ValidationError",
  "ZodError",
]);

// error → bounded metric label. "none" when there's no error, "unknown" for a
// non-Error throw, the raw name when it's a known type, else "other".
function errorMetricLabel(error: unknown): string {
  if (!error) return "none";
  if (!(error instanceof Error)) return "unknown";
  return KNOWN_ERROR_TYPES.has(error.name) ? error.name : "other";
}

// ── Parenting our spans under Mastra's active span ──────────────────────────
//
// Mastra's AITracing keeps its own span tree (parentSpanId/traceId) and does
// NOT push spans onto the OTel `context.active()` stack — so a naive
// startSpan(..., context.active()) makes our LLM/tool/retrieval span a detached
// ROOT, breaking the end-to-end waterfall (agent_run → model_generation →
// tool_call/retrieve all in one trace) that the SigNoz AI trace view is built
// on. Mastra DOES expose the currently-executing AISpan via getCurrentSpan()
// (an AsyncLocalStorage that survives the AI-SDK middleware's await boundary —
// verified at runtime), and every AISpan carries an OTel-compatible `traceId`
// (32 hex) + `id` used AS the OTLP spanId (this is exactly what @mastra/otel-
// exporter does: spanId = span.id, verbatim). So we read that span and forge a
// non-recording parent SpanContext with the SAME ids; startSpan(childCtx) then
// stitches our span into Mastra's trace as a proper child.
//
// Defensive: if there's no active Mastra span, or its ids aren't valid OTLP hex
// (16 for span, 32 for trace), we fall back to context.active() — a detached
// span is strictly better than one the OTLP endpoint silently drops for an
// invalid id. Never throws.
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;

// A trace ref (traceId + a spanId in it) we can forge an OTel parent from.
type TraceLink = { traceId: string; spanId: string };

// Per-turn holder for the turn's trace ref. The answer-quality span is scored in
// Next's after() — LONG after the agent span (and Mastra's getCurrentSpan ALS)
// are gone — so it can't parent itself the way LLM/tool spans do inline. We
// stash the turn's trace ref HERE while the agent is live, then the after()
// scorer reads it to join the SAME trace. Next preserves the request's ALS
// snapshot into after(), and the agent generator (created inside runWithTurnTrace)
// restores this store when it resumes — so both sides share one holder. Purely a
// correlation aid: if it's ever empty (ALS didn't propagate), the eval span
// falls back to a detached root — no worse than before, never throws.
const turnTraceStore = new AsyncLocalStorage<{ link?: TraceLink }>();

// Wrap a request turn so spans emitted during it can register their trace ref
// for the later after() scorer. No-op-safe: nested calls just reuse the store.
export function runWithTurnTrace<T>(fn: () => T): T {
  return turnTraceStore.run({}, fn);
}

// enterWith variant for a request handler: opens the holder for the CURRENT
// async context (and everything downstream — the stream, the agent generator,
// the after() drain) without wrapping the whole body in a callback. Safe because
// each Next request handler runs in its own async context, so this never leaks
// across requests. Idempotent: skips if a holder is already open.
export function beginTurnTrace(): void {
  if (!turnTraceStore.getStore()) turnTraceStore.enterWith({});
}

// The turn's trace ref, if any LLM span registered one this turn. Read in after().
export function currentTurnLink(): TraceLink | undefined {
  return turnTraceStore.getStore()?.link;
}

// Forge a non-recording OTel parent context from a trace ref, so a span started
// with it joins that existing trace as a child. Same mechanism as
// mastraParentContext, but from an explicitly captured ref (survives after()).
export function parentContextFromLink(link: TraceLink): Context {
  return trace.setSpanContext(context.active(), {
    traceId: link.traceId,
    spanId: link.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export function mastraParentContext(): Context {
  try {
    const span = getCurrentSpan() as
      | { id?: string; traceId?: string }
      | undefined;
    const spanId = span?.id;
    const traceId = span?.traceId;
    if (
      typeof spanId === "string" &&
      typeof traceId === "string" &&
      SPAN_ID_RE.test(spanId) &&
      TRACE_ID_RE.test(traceId)
    ) {
      // Register the FIRST valid ref this turn so the after() answer-quality
      // scorer can join this trace. First = closest to the agent_run root.
      const store = turnTraceStore.getStore();
      if (store && !store.link) store.link = { traceId, spanId };
      return trace.setSpanContext(context.active(), {
        traceId,
        spanId,
        // Sampled so SigNoz keeps the child; isRemote so OTel treats it as an
        // injected parent rather than one it started.
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    }
  } catch {
    // getCurrentSpan should never throw, but parenting is best-effort — a
    // detached span beats losing telemetry.
  }
  return context.active();
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
        finishReason: finishReasonText(result.finishReason),
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

    let usage: unknown;
    let finishReason: string | undefined;
    // Timestamp of the first content chunk — for time-to-first-token. Set once,
    // on the earliest text/reasoning delta the model streams.
    let firstChunkAt: number | undefined;
    // Guard: the span is emitted exactly once, whichever terminal event wins
    // (finish → flush, in-band error part, or stream setup rejection). Without
    // this an error part followed by a graceful close would double-emit.
    let emitted = false;

    const emitOnce = (extra: { error?: unknown }) => {
      if (emitted) return;
      emitted = true;
      emitLlmSpan({
        modelId: model.modelId,
        provider: providerOf(model),
        usage,
        durationMs: Date.now() - started,
        finishReason,
        ttftMs:
          firstChunkAt !== undefined ? firstChunkAt - started : undefined,
        error: extra.error,
      });
    };

    let stream: ReadableStream;
    let rest: Record<string, unknown>;
    try {
      // A synchronous stream-setup failure (auth, rate-limit, transport error
      // BEFORE the first chunk) rejects here. wrapGenerate catches its
      // equivalent; wrapStream must too — otherwise the error path of the
      // MAJORITY flow (every chat turn streams) emits no span at all.
      ({ stream, ...rest } = await doStream());
    } catch (error) {
      emitOnce({ error });
      throw error;
    }

    // Tap the stream to capture the terminal usage without altering it. The AI
    // SDK emits a "finish" part carrying usage + finishReason at stream end.
    const tapped = stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          // First real output delta marks TTFT. Ignore stream-start/metadata
          // parts — only content deltas count as "the model started answering".
          if (
            firstChunkAt === undefined &&
            (chunk?.type === "text-delta" || chunk?.type === "reasoning-delta")
          ) {
            firstChunkAt = Date.now();
          }
          if (chunk?.type === "finish") {
            usage = chunk.usage;
            finishReason = finishReasonText(chunk.finishReason);
          }
          // In-band error: the SDK streams an "error" part instead of rejecting
          // the stream. flush() still runs on close, so WITHOUT this the span
          // would be emitted as a SUCCESS and mask the failure. Emit an error
          // span now; the emitted-guard makes the later flush() a no-op.
          if (chunk?.type === "error") {
            emitOnce({
              error:
                (chunk as { error?: unknown }).error ??
                new Error("stream error"),
            });
          }
          controller.enqueue(chunk);
        },
        flush() {
          // Graceful close (success, or after an already-emitted error part).
          emitOnce({});
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
  const tracer = getSignozTracer();
  if (!tracer) return;

  const span = tracer.startSpan(
    `execute_tool ${args.toolName}`,
    { kind: SpanKind.CLIENT, startTime: new Date(Date.now() - args.durationMs) },
    // Parent under Mastra's active agent span so the tool_call joins the E2E
    // trace (agent_run → model_generation → execute_tool) instead of a root.
    mastraParentContext(),
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
    // Correlated ERROR log for the failing tool, linked to this span.
    emitErrorLog({
      operation: "execute_tool",
      body: `Tool failed: ${args.toolName}`,
      error: args.error,
      span,
      attributes: { "gen_ai.tool.name": args.toolName },
    });
  }
  span.end();

  // Tool latency as a first-class metric (labelled by tool + outcome).
  const inst = getInstruments();
  if (inst) {
    inst.duration.record(args.durationMs / 1000, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": args.toolName,
      "error.type": errorMetricLabel(args.error),
    });
  }
}

// A Mastra tool: the only field we touch is `execute`, whose signature we keep
// intact by inference. `id` names the span.
//
// `unknown[]` (not `never[]`): the wrapper is signature-agnostic, but `never[]`
// makes the parameter list UNCALLABLE in the checker — every call site type-
// checks vacuously, so a genuinely wrong forwarding of args would slip through.
// `unknown[]` keeps the pass-through generic while the arity/forwarding still
// gets checked. The concrete tool's real signature is preserved by `T` either way.
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
  const original = tool.execute.bind(tool) as (...a: unknown[]) => unknown;

  const wrapped = async (...callArgs: unknown[]) => {
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

// ════════════════════════════════════════════════════════════════════════
// Retrieval (RAG) telemetry
// ════════════════════════════════════════════════════════════════════════
//
// Same rationale as the LLM/tool spans: Mastra's own exporter never lands a
// queryable retrieval span in SigNoz. Memory's semanticRecall runs a pgvector
// similarity search on every agent turn — the "retrieval hop" of the E2E trace
// (embed query → cosine search → inject top-k as context). We emit ONE CLIENT
// span per vector query so that hop is visible: the index it hit, top-k
// requested, how many rows came back, the best (top) similarity score, and
// latency. error.type on failure. mastra.span.type = "retrieval" is a new
// discriminator the dashboard/alerts can filter on.
//
// db.system=pgvector follows the OTel semantic convention for DB spans, so the
// span also reads as a database call in generic SigNoz DB views.

// One row of a pgvector query result — only the fields we read for attributes.
type VectorHit = { score?: number };

function emitRetrievalSpan(args: {
  indexName: string;
  topK: number;
  hitCount: number;
  topScore?: number;
  durationMs: number;
  error?: unknown;
}) {
  const tracer = getSignozTracer();
  if (!tracer) return;

  const span = tracer.startSpan(
    `retrieve ${args.indexName}`,
    { kind: SpanKind.CLIENT, startTime: new Date(Date.now() - args.durationMs) },
    // Parent under Mastra's active agent span so the retrieval hop joins the E2E
    // trace instead of a detached root.
    mastraParentContext(),
  );

  span.setAttribute("gen_ai.operation.name", "retrieve");
  // Discriminator our versioned SigNoz dashboards/alerts filter on. New value
  // (retrieval) — distinct from model_generation / tool_call.
  span.setAttribute("mastra.span.type", "retrieval");
  // OTel DB semantic-convention attrs so the span also reads as a vector search.
  span.setAttribute("db.system", "pgvector");
  span.setAttribute("db.operation.name", "query");
  span.setAttribute("db.collection.name", args.indexName);
  span.setAttribute("gen_ai.retrieval.top_k", args.topK);
  span.setAttribute("gen_ai.retrieval.returned_count", args.hitCount);
  if (args.topScore !== undefined) {
    span.setAttribute("gen_ai.retrieval.top_score", args.topScore);
  }
  if (args.error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(
      "error.type",
      args.error instanceof Error ? args.error.name : "unknown",
    );
    // Correlated ERROR log for the failing retrieval hop, linked to this span.
    emitErrorLog({
      operation: "retrieve",
      body: `Retrieval failed: ${args.indexName}`,
      error: args.error,
      span,
      attributes: { "db.collection.name": args.indexName },
    });
  }
  span.end();

  // Retrieval-hop latency as a first-class metric (labelled by index + outcome).
  const inst = getInstruments();
  if (inst) {
    inst.duration.record(args.durationMs / 1000, {
      "gen_ai.operation.name": "retrieve",
      "db.collection.name": args.indexName,
      "error.type": errorMetricLabel(args.error),
    });
  }
}

// The query method on a Mastra vector store: takes an object with
// { indexName, topK?, ... } and resolves an array of scored hits. We read only
// indexName/topK off the args and score off the hits — everything else stays
// opaque and passes through untouched. The store type is left generic so the
// wrapper preserves PgVector's exact query signature (strict indexName, its own
// QueryResult return) instead of narrowing it.
type QueryArgs = { indexName?: string; topK?: number };
type VectorStore = {
  query: (...args: never[]) => Promise<unknown[]>;
};

// Wrap a Mastra vector store so each `.query()` emits a retrieval span. Mutates
// the store's `query` in place (PgVector is a class instance — spreading it would
// drop its prototype methods), swapping in a wrapper that preserves the exact
// signature and only side-effects a span. Idempotent: re-wrapping is a no-op via
// the marker. No-op if there's no query method.
const VECTOR_WRAPPED = Symbol.for("casper.vectorTelemetryWrapped");

export function withVectorTelemetry<T extends VectorStore>(store: T): T {
  if (typeof store.query !== "function") return store;
  const marked = store as T & { [VECTOR_WRAPPED]?: boolean };
  if (marked[VECTOR_WRAPPED]) return store;
  const original = store.query.bind(store) as (
    ...args: unknown[]
  ) => Promise<unknown[]>;

  const wrappedQuery = async (...callArgs: unknown[]): Promise<unknown[]> => {
    const started = Date.now();
    // First positional arg is the { indexName, topK, ... } params object. Read
    // it defensively — we don't own its exact type here.
    const queryArgs = callArgs[0] as QueryArgs | undefined;
    const indexName = queryArgs?.indexName ?? "unknown";
    // Mastra's PgVector defaults topK to 10 when omitted (see query signature).
    const topK = queryArgs?.topK ?? 10;
    try {
      const hits = await original(...callArgs);
      // Hits come back sorted by score desc, so hits[0] is the best match.
      const topScore =
        hits.length > 0 ? (hits[0] as VectorHit)?.score : undefined;
      emitRetrievalSpan({
        indexName,
        topK,
        hitCount: hits.length,
        topScore,
        durationMs: Date.now() - started,
      });
      return hits;
    } catch (error) {
      emitRetrievalSpan({
        indexName,
        topK,
        hitCount: 0,
        durationMs: Date.now() - started,
        error,
      });
      throw error;
    }
  };

  marked.query = wrappedQuery as T["query"];
  marked[VECTOR_WRAPPED] = true;
  return store;
}
