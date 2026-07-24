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

The committed value is a **PLACEHOLDER**: `0.0000009` USD/token (= $0.90 per 1M)
for both input and output. **Replace both constants** in the `F1` formula
`expression` (panels `Est. cost (USD)` and `Est. cost over time by model`) with
the real Fireworks `glm-5p2` per-token rates before trusting the cost figures.

### Import

Dashboards → **New dashboard** → **Import JSON** → paste this file (or upload).
Requires a SigNoz build on dashboard schema `v6`.
