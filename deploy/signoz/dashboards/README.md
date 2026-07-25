# SigNoz dashboards (versioned)

Custom SigNoz dashboards for CasperAgent's agent/LLM observability, built on the
OTLP traces the app already exports (see [`../../../SIGNOZ.md`](../../../SIGNOZ.md)).

## `agent-llm-observability.json`

Agent-native observability across **traces, metrics and logs** — 30 panels.

> **One control before anything else: the `Environment` variable** at the top of
> the dashboard. Every traces panel is scoped to
> `deployment.environment.name = $environment` (default `production`). Set it to
> your `DEPLOYMENT_ENVIRONMENT` — `development` if you're running `pnpm dev` —
> or the panels are correct and empty. See [below](#the-environment-variable).

Panels:

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
| Answer coverage (avg) | `avg(mastra.eval.score)` — lexical COVERAGE of the request, not correctness (see note below) |
| Answer coverage over time | coverage time series — read the shape, not the level |
| **Token rate (metric) by type** | `rate` of `gen_ai.client.token.usage` counter, grouped by `gen_ai.token.type` — `signal: metrics` |
| **LLM cost (metric) by model** | `increase` of `gen_ai.client.operation.cost` counter (real USD), grouped by model — `signal: metrics` |
| **Operation p95 latency (metric histogram)** | `p95` of `gen_ai.client.operation.duration` histogram, grouped by `gen_ai.operation.name` — `signal: metrics` |
| RAG retrieval p95 latency | `p95(duration_nano)` where `mastra.span.type = 'retrieval'`, grouped by `db.collection.name` |
| RAG top similarity score | `avg(gen_ai.retrieval.top_score)` grouped by collection |
| Empty retrievals | `count()` where `gen_ai.retrieval.returned_count = 0` |
| Health-watch failures | `count()` where `mastra.span.type = 'health_watch' AND mastra.health_watch.ok = false` |
| Health-watch heartbeats | `count()` where `...ok = true` — proof of life; **zero is the alarming reading** |
| **Model failovers** | `count()` where `mastra.span.type = 'model_failover'` |
| **Failovers by target & trigger** | `count()` grouped by `model.failover.to` + `model.failover.source` |
| **Error logs over time by operation** | `count()` of ERROR log records grouped by `gen_ai.operation.name` — `signal: logs` |
| **Error logs by type** | `count()` grouped by `error.type` — `signal: logs` |
| Pipeline: runs / reached tool / reached generation | `count_distinct(trace_id)` per stage, matched on `gen_ai.operation.name` |
| Tool conversion % · Generation conversion % | formula `(B/A)*100` over the stage counts |
| Pipeline drop-off over time | the three stage counts as a time series |

### The `Environment` variable

Every traces panel carries two scoping filters: `casper.self_instrumented = true`
(de-duplication — see below) and `deployment.environment.name = $environment`.

That second one is a **dashboard variable** (`TextVariable`, default
`production`), not a hardcoded value, for one reason: the app stamps
`deployment.environment.name` from `DEPLOYMENT_ENVIRONMENT ?? VERCEL_ENV ??
NODE_ENV` ([`llm-telemetry.ts`](../../../src/mastra/llm-telemetry.ts)), so a
`pnpm dev` run emits `development` and a dashboard pinned to `production` would
render every panel at zero — correct, and indistinguishable from "the
instrumentation is broken". Change the value in the box at the top of the
dashboard instead of editing this JSON.

Why scope by environment at all: verification scripts and health probes emit
spans under their own environments (`e2e-verify`, `smoke`, `fr-probe`,
`hw-probe`) with fabricated model and tool names (`e2e1784862343489`,
`casper-probe-*`). Unscoped, they read as real models in a spend-by-model
breakdown and their deliberate failures inflate the tool-failure panels.

Two deliberate exclusions:

- **The pipeline-conversion row is not scoped by it.** Its first stage counts
  Mastra's *native* `invoke_agent` spans, which come from a different OTel
  resource and carry no `deployment.environment.name` at all. Scoping the later
  stages while the denominator stays unscoped shrinks the numerator against a
  full denominator and reports a fake drop-off. All three stages instead share
  `casper.in_agent_run = true`, which already keeps probe and workflow traffic
  out — that marker exists for exactly this reason.
- **The logs panels are not scoped by it.** The exported log records don't carry
  the attribute in a filterable form (verified against SigNoz v0.134: the same
  filter returns 0 rows on `signal: logs` while returning 94 on `signal:
  traces`). They're scoped by `gen_ai.operation.name EXISTS` instead, which
  isolates our correlated error logs from Mastra's internal log noise.

Alert rules keep the literal `'production'`: a rule evaluates on a schedule with
no dashboard open, so there is no variable to interpolate. Edit the value in
[`../alerts/*.json`](../alerts/) if you page on a different environment.

### The retrieval + health-watch panels

The app emits a span for the **RAG retrieval hop** (pgvector semantic recall,
`mastra.span.type = 'retrieval'`) and for the **autonomous health-watch** cron
(`health_watch`). Both were instrumented before any panel consumed them — the
telemetry was produced and thrown away. These four close that gap.

Retrieval is worth its own panels because it runs on *every* agent turn, ahead
of the model call: when it slows down the whole turn slows down, and when
`top_score` drifts down the agent is grounding its answers on progressively
worse context — a leading indicator of the coverage regression that
`answer-quality-low` only catches after the fact.

The two health-watch panels are the watchdog's own vital signs, and they are a
PAIR on purpose. `Health-watch failures` (`ok = false`) counts passes that ran
and broke; `Health-watch heartbeats` (`ok = true`) counts passes that ran and
succeeded. The failures panel alone was ambiguous in the worst direction: a
watchdog that stopped running emits nothing, so it renders the same calm zero as
a perfectly healthy hour. Reading them together disambiguates — zero failures
AND zero heartbeats means the loop is dead, not well. That state pages via
[`../alerts/health-watch-absent.json`](../alerts/README.md) (SigNoz
`alertOnAbsent`), and the `ok = false` filter on the failures panel is required
now that heartbeats share the same span type.

### Answer coverage is not answer quality

The two coverage panels read `mastra.eval.score`, produced by `@mastra/evals`'
`completeness` scorer: `covered_elements / total_input_elements` over elements
extracted from the REQUEST. It measures how much of the question the answer
engaged with — not whether the answer was right. A reply that echoes the
prompt's vocabulary scores high; a correct terse reply can score low. Read both
panels as DROP detectors against this service's own baseline (truncation cap,
degraded retrieval, prompt/model regression), never as a grade. Correctness
would need an LLM judge scorer — deliberately out of scope, since it would put a
paid model call on every turn. See `../../../src/mastra/agent-quality.ts`.

### The failover panels — SigNoz as a runtime input

The last two panels (`Model failovers`, `Failovers by target & trigger`) read
`mastra.span.type = 'model_failover'` — a span the app emits when it reroutes off
a degraded primary provider to its fallback, *on its own*, based on health it
reads back out of SigNoz. This is the axis the rest of the dashboard doesn't
cover: not "what did the agent do" but "what did the agent do BECAUSE of what it
saw about itself". `model.failover.source` records which signal tripped it —
`local` (this pod's recent error burst), `signoz` (a fleet-wide error-rate/p95
regression queried back from SigNoz), or `forced` (the demo override). 0 in a
healthy window; nonzero means the primary crossed threshold and the system
protected the turn. Paired with `../alerts/model-failover.json`. Mechanism:
`src/mastra/model-health.ts` + `src/mastra/model.ts`.

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
