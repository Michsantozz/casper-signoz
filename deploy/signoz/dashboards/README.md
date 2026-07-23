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

### Why these attributes

The Mastra `OtelExporter` emits the OpenTelemetry GenAI semantic conventions:
`gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens` (numeric),
`gen_ai.tool.name`, plus `mastra.span.type` on every span. LLM panels filter on
`mastra.span.type = 'model_generation'` — the exact discriminator our spans carry
(more reliable here than `gen_ai.system`, which this exporter does not emit).

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
