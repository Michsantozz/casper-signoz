import {
  Observability,
  MastraStorageExporter,
  ConsoleExporter,
} from "@mastra/observability";
import type { ObservabilityExporter } from "@mastra/core/observability";
import { LangfuseExporter } from "@mastra/langfuse";
import { OtelExporter } from "@mastra/otel-exporter";

/**
 * Observability for the agent — traces, model-generation spans, and (crucially)
 * the human-feedback pipeline. Without this configured, `mastra.observability`
 * is the NoOp entrypoint: `addFeedback()` silently discards, so the 👍/👎 in the
 * chat would go nowhere.
 *
 * `MastraStorageExporter` persists spans + feedback into the app's PG (schema
 * `mastra`, same store as memory/workflows). It implements `onFeedbackEvent`,
 * which is what makes `mastra.observability.addFeedback(...)` durable — the
 * signal lands in the observability domain and can be read back via
 * `listFeedback` / `getFeedbackAggregate`. It also implements `onMetricEvent`,
 * so the token / cost / latency metrics Mastra auto-emits on every
 * MODEL_GENERATION span (mastra_model_total_input_tokens, estimatedCost,
 * mastra_{agent,tool,workflow}_duration_ms, …) already land in PG.
 *
 * `LangfuseExporter` (added only when LANGFUSE_* keys are set) forwards those
 * same spans + metrics to the Langfuse dashboard, so token spend, per-model
 * cost, and step/tool latency become navigable instead of trapped in PG. The
 * deps (`@mastra/langfuse`, `@langfuse/otel`) ship regardless; the export is a
 * pure env toggle — absent keys → PG only, no behavioural change.
 *
 * `Observability` auto-applies a `SensitiveDataFilter` span output processor to
 * every instance, so transcript/PII text captured in spans is scrubbed before
 * export. We keep that default on.
 *
 * A ConsoleExporter is added in dev so traces are visible locally; in prod only
 * the storage (+ optional Langfuse) exporter runs.
 */
export function createObservability(): Observability {
  const exporters: ObservabilityExporter[] = [new MastraStorageExporter()];

  // Ship traces + token/cost/latency to Langfuse when configured. env-schema
  // enforces both keys together, so checking one is enough here.
  if (process.env.LANGFUSE_PUBLIC_KEY) {
    exporters.push(
      new LangfuseExporter({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: process.env.NODE_ENV,
      }),
    );
  }

  // Ship the same agent spans (tool calls, LLM generations, RAG, workflows)
  // + token/cost/latency metrics to SigNoz over OTLP. Two modes, env-toggled:
  //   - Self-host: SIGNOZ_ENDPOINT set (e.g. http://localhost:4318/v1/traces)
  //     and NO api key → OTLP `custom` provider, no ingestion header. This is
  //     the local docker path; the built-in `signoz` provider can't be used
  //     because it hard-requires an ingestion key and disables tracing without
  //     one (see resolveSignozConfig in @mastra/otel-exporter).
  //   - Cloud: SIGNOZ_API_KEY set → `signoz` provider (region defaults to us),
  //     endpoint optional (overrides the ingest.<region>.signoz.cloud default).
  if (process.env.SIGNOZ_API_KEY || process.env.SIGNOZ_ENDPOINT) {
    exporters.push(
      new OtelExporter({
        provider: process.env.SIGNOZ_API_KEY
          ? {
              signoz: {
                apiKey: process.env.SIGNOZ_API_KEY,
                region: process.env.SIGNOZ_REGION as
                  | "us"
                  | "eu"
                  | "in"
                  | undefined,
                endpoint: process.env.SIGNOZ_ENDPOINT,
              },
            }
          : {
              custom: {
                // self-host OTLP HTTP ingest. http/json uses
                // @opentelemetry/exporter-trace-otlp-http (already a dep); the
                // http/protobuf path needs the -proto exporters which aren't
                // installed, so json is the working default here.
                endpoint: process.env.SIGNOZ_ENDPOINT!,
                protocol: "http/json",
              },
            },
        // Traces only. The OTLP *logs* exporters (-logs-otlp-http/-proto) are
        // not installed; leaving logs enabled just spams "exporter not
        // installed" on every boot. Enable + add the dep if log export is
        // wanted later.
        signals: { traces: true, logs: false },
      }),
    );
  }

  // Local visibility only — noisy in prod, and the traces are queryable in PG.
  if (process.env.NODE_ENV !== "production") {
    exporters.push(new ConsoleExporter());
  }

  return new Observability({
    configs: {
      default: {
        serviceName: "casper-assistant",
        exporters,
      },
    },
  });
}
