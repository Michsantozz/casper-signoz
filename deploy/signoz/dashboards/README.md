# SigNoz dashboards (versioned)

Custom SigNoz dashboards for CasperAgent's agent/LLM observability, built on the
OTLP traces the app already exports (see [`../../../SIGNOZ.md`](../../../SIGNOZ.md)).

## `agent-llm-observability.json`

Agent-native observability over `signal: traces`. Panels:

| Panel | Query |
|-------|-------|
| LLM calls | `count()` where `mastra.span.type = 'model_generation'` |
| Total tokens | `sum(gen_ai.usage.input_tokens)` + `sum(gen_ai.usage.output_tokens)` |
| Est. cost (USD) | formula `A*PRICE_IN + B*PRICE_OUT` over token sums |
| p95 latency (LLM) | `p95(duration_nano)` on generations |
| Tool calls | `count()` where `mastra.span.type = 'tool_call'` |
| Tokens over time by model | token sums grouped by `gen_ai.request.model` |
| Est. cost over time by model | cost formula grouped by model |
| LLM latency p50/p95/p99 | duration percentiles over time |
| Calls by tool | `count()` grouped by `gen_ai.tool.name` |
| Errors by type | `count()` grouped by `error.type` |
| Answer quality (avg completeness) | avg over answer-quality spans |
| Answer quality over time | avg completeness time series |
| **Token rate (metric) by type** | `rate` of `gen_ai.client.token.usage` counter, grouped by `gen_ai.token.type` — `signal: metrics` |
| **LLM cost (metric) by model** | `increase` of `gen_ai.client.operation.cost` counter (real USD), grouped by model — `signal: metrics` |
| **Operation p95 latency (metric histogram)** | `p95` of `gen_ai.client.operation.duration` histogram, grouped by `gen_ai.operation.name` — `signal: metrics` |
| RAG retrieval p95 latency | `p95(duration_nano)` where `mastra.span.type = 'retrieval'`, grouped by `db.collection.name` |
| RAG top similarity score | `avg(gen_ai.retrieval.top_score)` grouped by collection |
| Empty retrievals | `count()` where `gen_ai.retrieval.returned_count = 0` |
| Health-watch failures | `count()` where `mastra.span.type = 'health_watch'` |

### The retrieval + health-watch panels

The app emits a span for the **RAG retrieval hop** (pgvector semantic recall,
`mastra.span.type = 'retrieval'`) and for the **autonomous health-watch** cron
(`health_watch`). Both were instrumented before any panel consumed them — the
telemetry was produced and thrown away. These four close that gap.

Retrieval is worth its own panels because it runs on *every* agent turn, ahead
of the model call: when it slows down the whole turn slows down, and when
`top_score` drifts down the agent is grounding its answers on progressively
worse context — a leading indicator of the quality regression that
`answer-quality-low` only catches after the fact. `Health-watch failures` is the
watchdog's own vital sign (paired with `../alerts/health-watch-down.json`).

### The metric-native panels (fifth SigNoz signal)

The last three panels read `signal: metrics` — the first-class OTel metrics the
app exports through the metrics pipeline (`llm-telemetry.ts` MeterProvider),
distinct from the trace-derived panels above. Mastra's `OtelExporter` forwards
only traces + logs, so these metrics exist ONLY because of the dedicated
pipeline. Their value: real metric time series (not span attributes), so the
Query Builder can aggregate them natively, PromQL works, and metric-based alerts
can evaluate on them (see `../alerts/*-metric.json`). Metric names follow the
OTel GenAI metric semconv: `gen_ai.client.token.usage` (counter),
`gen_ai.client.operation.cost` (counter, USD), `gen_ai.client.operation.duration`
(histogram, seconds). Cost here is the **real** app-computed figure, not a
placeholder formula.

### Why these attributes

The Mastra `OtelExporter` emits the OpenTelemetry GenAI semantic conventions:
`gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens` (numeric),
`gen_ai.tool.name`, plus `mastra.span.type` on every span. LLM panels filter on
`mastra.span.type = 'model_generation'` — the exact discriminator our spans carry.

Our own `llm-telemetry.ts` additionally emits the attributes SigNoz's **built-in**
"AI Observability" dashboard keys on, so the same spans light up SigNoz's native
panels too (not just our versioned dashboard): `gen_ai.system` (the legacy
provider alias the native dashboard uses to recognize an LLM span),
`gen_ai.server.ttft` (time-to-first-token, streaming) and `gen_ai.error.type`.

### ⚠️ Cost is a derived estimate — set the real price

The exporter does **not** emit a per-call cost attribute, so cost is computed by
formula: `input_tokens * PRICE_IN + output_tokens * PRICE_OUT`.

The committed constants are the **real Fireworks kimi-k2p7-code rates**:
`0.00000095` USD/token input (= $0.95 / 1M) and `0.000004` USD/token output
(= $4.00 / 1M), in the `F1` formula `expression` (panels `Est. cost (USD)` and
`Est. cost over time by model`). This trace-side figure prices the whole input
total at the input rate (no cache-read discount), so it slightly overstates
cache-heavy turns; the **metric cost panel** (`gen_ai.client.operation.cost`) is
the cache-accurate, exact-USD source. If you switch models, update both
constants to match your provider's per-token price.

### Import

Dashboards → **New dashboard** → **Import JSON** → paste this file (or upload).
Requires a SigNoz build on dashboard schema `v6`.
