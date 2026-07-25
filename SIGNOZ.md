# SigNoz Observability

> ### ⚠️ Read this before anything else — two ways to see an empty dashboard
>
> Both are silent. Neither reports an error. Together they are the only real
> setup hazard in this guide.
>
> **1. The v2 dashboard renderer is behind a default-off flag.** The versioned
> dashboard uses the v2 (Perses) schema (`schemaVersion: v6`). On current builds
> the UI silently falls back to the legacy renderer and shows *"Welcome to your
> new dashboard"* even though all 30 panels exist in the API. Set it on the
> SigNoz service and recreate the container:
>
> ```yaml
> # pours/deployment/compose.yaml, service signoz-signoz-0, under environment:
> - SIGNOZ_FLAGGER_CONFIG_BOOLEAN_USE__DASHBOARD__V2=true
> ```
>
> ```bash
> docker compose up -d signoz-signoz-0
> ```
>
> **2. The dashboard opens scoped to `production`.** The `Environment` box at the
> top defaults to `production`, and a `pnpm dev` run stamps `development` — so
> every panel renders a correct, honest **zero**. Type your environment into the
> box, or export `DEPLOYMENT_ENVIRONMENT=production` when you drive the app.
>
> Details on both: [the flag](#-enable-the-v2-dashboard-renderer-required) ·
> [the variable](#set-the-environment-variable-first).


OpenTelemetry-native observability for the CasperAgent agent stack (Mastra +
Vercel AI SDK + Claude Agent SDK), across all **three OTLP signals — traces,
metrics, and logs**. Agent spans — tool calls, LLM generations, RAG hops, Inngest
workflows — export over OTLP (`http/protobuf`) to a SigNoz instance, with
token/cost/latency riding along as `gen_ai.*` span attributes.

Two signals are **self-instrumented** in `src/mastra/llm-telemetry.ts`, because
Mastra's own `OtelExporter` forwards only traces + its internal log events (no
`onMetricEvent`, sparse logs). That module stands up its own OTLP MeterProvider
and LoggerProvider (twins of the tracer) so the same numbers ALSO land as:
- first-class **metrics** (`gen_ai.client.token.usage/operation.cost/duration`) —
  a real time-series store for PromQL/metric alerts, not just span attributes;
- correlated ERROR **logs** — one log record per failure, stamped with the failing
  span's `traceId`+`spanId`, so a log line in SigNoz deep-links to the exact span
  in the trace waterfall. This is the cross-signal correlation the "correlate
  signals across your stack" goal is about — click a log, land on its trace.

SigNoz has **no proprietary SDK**: the app speaks standard OTel, SigNoz just
receives it via OTLP. Same spans already feed Langfuse and PG; SigNoz is an
additional, independent sink (all three can run at once).

## Wiring (already in the codebase)

- `src/mastra/observability.ts` — adds `OtelExporter` (`@mastra/otel-exporter`)
  to the Mastra `Observability` when SigNoz env is set. Exports the `traces` and
  `logs` signals (both `http/protobuf`). Two modes:
  - **Self-host**: `SIGNOZ_ENDPOINT` set, no key → OTLP `custom` provider
    (`http/protobuf`, no ingestion header). Requires
    `@opentelemetry/exporter-trace-otlp-proto` + `-logs-otlp-proto` (both deps).
  - **Cloud**: `SIGNOZ_API_KEY` (+ optional `SIGNOZ_REGION`) → `signoz` provider.
    The built-in provider hard-requires the ingestion key, which is why
    self-host must use `custom`.
- `src/shared/lib/env-schema.ts` — declares `SIGNOZ_ENDPOINT`, `SIGNOZ_API_KEY`,
  `SIGNOZ_REGION` (all optional). Absent → no SigNoz export, zero behaviour
  change.
- `.env.local` — `SIGNOZ_ENDPOINT=http://localhost:4318/v1/traces` for local
  self-host.

## Run the SigNoz server (self-host, Docker)

Compose files under `deploy/` in the SigNoz repo are deprecated (v0.130.0+).
Install path is now **Foundry**.

The reproducible deploy spec lives in this repo at
[`deploy/signoz/casting.yaml`](deploy/signoz/casting.yaml) (with its resolved
`casting.yaml.lock`). Judges can re-run Foundry against them to reproduce this
exact SigNoz deployment (SigNoz server + MCP server).

```bash
# 1. install foundryctl
curl -fsSL https://signoz.io/foundry.sh | bash

# 2. deploy from the versioned spec
#    (validates docker, generates compose in pours/deployment/, starts)
foundryctl cast -f deploy/signoz/casting.yaml
```

Ports (this deployment — foundry default is `8080`, remapped here to avoid a
host conflict):
- **UI** → http://localhost:8090  (container `8080`, host-mapped to `8090`)
- **OTLP ingest** → 4317 (gRPC) / 4318 (HTTP)
- **MCP server** → `signoz-mcp` container is up but publishes no host port here
  (`:8000` is taken by another stack). Reach it in-network or add a mapping
  before wiring the SRE-copilot idea (agent queries its own telemetry).

> Needs ~4GB RAM allocated to Docker. Containers healthy in ~1 min.

### ⚠️ Enable the v2 dashboard renderer (required)

The versioned dashboard uses the **v2 (Perses) schema** (`schemaVersion: v6`).
On current SigNoz builds the v2 dashboard renderer is behind an experimental,
**default-off** feature flag (`use_dashboard_v2`). Without it the UI silently
falls back to the legacy renderer and shows an empty "Welcome to your new
dashboard" even though the panels exist in the API. Turn it on for the SigNoz
service (env → `flagger.config.boolean.use_dashboard_v2`):

```yaml
# pours/deployment/compose.yaml, service signoz-signoz-0, under environment:
- SIGNOZ_FLAGGER_CONFIG_BOOLEAN_USE__DASHBOARD__V2=true
```

```bash
docker compose up -d signoz-signoz-0   # recreate to pick up the flag
```

(The `__` in the env key is a literal underscore in the flag name, per SigNoz's
env-var convention; single `_` separates config levels.)

## Import the dashboard + alerts

Everything is versioned as code and pushed over the REST API with a
service-account key (`SIGNOZ-API-KEY` header). **One command applies all of it:**

1. **Create a service account key** (once, as an admin) — SigNoz UI →
   *Settings → Service Accounts* → create account (editor role) → create key.
   Or via API: `POST /api/v1/service_accounts` → `POST /api/v1/service_accounts/{id}/keys`.
2. **Apply everything:**

   ```bash
   SIGNOZ_INSTANCE_URL=http://localhost:8090 \
   SIGNOZ_MCP_API_KEY=<service-account-key> \
   pnpm signoz:import              # add --dry-run to validate without writing
   ```

   It pushes the notification **channel** first (the rules reference it by name
   and SigNoz will not create it for them), then the **dashboard**, then every
   **alert rule**. Idempotent by name — absent → created, present → updated, so
   re-running converges instead of piling up duplicates. `--dry-run` runs each
   rule through `POST /api/v2/rules/test`, so a malformed query is caught before
   anything is written; `--only=channels|dashboards|alerts` narrows the run.
   Exits non-zero on any failure. Source: [`scripts/signoz-import.ts`](scripts/signoz-import.ts).

The endpoints it drives, if you'd rather do it by hand: `POST /api/v1/channels`,
`POST /api/v2/dashboards` (body `{ schemaVersion, name (RFC-1123 slug),
tags:[{key,value}], spec }` — the JSON's `spec` is used as-is), and
`POST /api/v2/rules` per file under [`deploy/signoz/alerts/`](deploy/signoz/alerts/).
Trace funnels stay manual on purpose — their steps match by exact `span_name`, so
importing one blind produces a funnel that never matches
([why](deploy/signoz/funnels/README.md)).

Panels populate once `gen_ai.*` traces are ingested (drive the agent first).

### Set the `Environment` variable first

The dashboard opens with an **`Environment`** box at the top (a `TextVariable`,
default `production`). Every traces panel is scoped to
`deployment.environment.name = $environment`, and the app stamps that attribute
from `DEPLOYMENT_ENVIRONMENT ?? VERCEL_ENV ?? NODE_ENV` — so a `pnpm dev` run
emits `development` and a dashboard left on `production` renders **every panel at
zero**. Either export `DEPLOYMENT_ENVIRONMENT=production` when you drive the app,
or type your environment into the box. No JSON editing either way. Rationale and
the two panels deliberately left unscoped: [`deploy/signoz/dashboards/README.md`](deploy/signoz/dashboards/README.md#the-environment-variable).

## Real LLM cost (not a placeholder)

The dashboard cost panels read `gen_ai.usage.cost` — a real $ figure the app
computes per span from token counts, not an estimate. Set both prices (per 1M
tokens) so every model_generation span carries its cost:

```bash
# Kimi K2.7 Code on Fireworks (the default model). Adjust per your model.
LLM_PRICE_INPUT_PER_MTOK=0.95
LLM_PRICE_OUTPUT_PER_MTOK=4.00
```

**Set a per-provider override whenever a fallback can serve traffic.** The pair
above is GLOBAL — it applies to every call regardless of which provider answered
it. That is wrong the moment the telemetry-driven failover below reroutes a turn
from Fireworks to Bedrock: the Bedrock call would be priced at the Fireworks
rate, so `gen_ai.usage.cost` isn't omitted, it's **emitted wrong** — precisely
during the incident the cost panels and the cost-spike alert exist for. Suffix
each price with the provider (`gen_ai.provider.name`, lowercased, non-alphanumerics
collapsed to `_`); anything without an override keeps using the global pair:

```bash
# Claude Sonnet 4.5 on Bedrock, the failover target. "amazon-bedrock" → amazon_bedrock
LLM_PRICE_INPUT_PER_MTOK__amazon_bedrock=3.00
LLM_PRICE_OUTPUT_PER_MTOK__amazon_bedrock=15.00
```

Input and output must be set together per provider (enforced at boot by
`env-schema.ts`, same as the global pair) — a lone override would price half the
provider's tokens at another provider's rate. The cache prices follow the same
rule and fall back to that provider's own input price.

Absent → the cost field is simply empty (no fabricated number). See
`src/mastra/llm-telemetry.ts` (`pricePerToken`). Note: SigNoz's own native
per-span cost processor (`signozllmpricing`, `_signoz.gen_ai.total_cost`) is
**EE/Cloud-only** — it is not in the OSS collector image, so on self-host OSS the
app-side computation above is the way to get real cost.

## Correlated logs — the fifth signal, deep-linked to traces

The app emits a first-class OTLP ERROR **log record** at each failure it already
traces — a failed LLM call, a failed tool execution, a failed retrieval hop —
from the same point it emits the error span (`emitErrorLog` in
`src/mastra/llm-telemetry.ts`). Each record carries:

- `severityNumber = ERROR`, a human `body` (`"LLM call failed: <model> (<type>)"`),
- `gen_ai.operation.name` (`chat` / `execute_tool` / `retrieve`), a **bounded**
  `error.type` label, and `exception.type` / `exception.message`,
- and — the point — the failing span's **exact trace context**: the log's
  `traceId`+`spanId` equal the error span's, via `LogRecord.context`. In SigNoz's
  Logs explorer you click the line and jump to that span in the waterfall.

This lights up two dashboard panels (`Error logs over time by operation`, `Error
logs by type`, bottom row of `agent-llm-observability.json`) and a logs-based
alert (`deploy/signoz/alerts/llm-error-logs.json`) — the logs signal is a
first-class citizen of the dashboard, not an empty tab. Filter
`gen_ai.operation.name EXISTS` isolates these correlated records from Mastra's
internal log noise. No-op when SigNoz is off; a logging failure never escapes onto
the request path.

## SRE-copilot — the agent queries its own telemetry

The app ships an `sreAgent` (registered in `src/mastra/index.ts`, delegated to by
the supervisor) that reads CasperAgent's OWN traces back out of SigNoz via the
**SigNoz MCP server** — so you can ask, in the app's home chat, "which tool is
failing the most", "how much did I spend on LLM calls today", "did any LLM call
error in the last hour", and it answers from live telemetry.

Wiring (all no-op if unset — see `.env.example`):

```bash
SIGNOZ_MCP_URL=http://signoz-mcp:8000/mcp     # the MCP server (HTTP transport)
SIGNOZ_MCP_API_KEY=<signoz-service-account-key>
SIGNOZ_INSTANCE_URL=http://signoz-signoz-0:8080
```

Network: the app container must share the SigNoz stack's network to reach both
the OTLP ingester and the MCP server by container name. `docker-compose.override.yml`
joins the app to `signoz-network` (declared `external` — bring SigNoz up first).
The app talks to the MCP over the internal network by container name, so the MCP's
host port binding is irrelevant (remove it from the generated compose if `:8000`
collides on the host). Files: `src/mastra/mcp-signoz.ts` (client),
`src/mastra/agents/sre.agent.ts` (agent).

## Autonomous alert provisioning — uniqueness enforced in code

The health-watch cron (`*/15`) drives the internal `sreAutomationAgent`, which is
authorized to **create** a SigNoz alert when it spots a real regression. Its MCP
toolset is least-privilege: reads plus `create_alert`/`create_dashboard` only —
update/delete/mute stay denied (`src/mastra/mcp-signoz.ts`).

That asymmetry is the risk: a loop that can only ADD, running 96×/day, turns
every duplicate into a permanent one. Relying on the prompt to prevent that
("list existing rules and don't duplicate one") puts a **semantic** judgment —
"does an existing rule cover this?" — in the hands of an LLM reasoning over names
it generated itself on earlier ticks.

So the split is explicit: **judgment stays in the agent, uniqueness lives in
code.** `withAlertIdempotency` wraps the create-alert tool and, before any write:

- derives a **canonical key** from the alert name (lowercased, punctuation
  collapsed) so cosmetic rewording maps to one identity;
- lists existing rules and turns a key collision into a **no-op** that reports
  back `deduplicated: true` (the agent is told coverage already exists);
- stamps survivors with the reserved `casper-auto/` prefix, so rules this loop
  owns are recognizable to later ticks and to operators;
- **fails closed** — if existing rules can't be listed, or the alert has no name,
  nothing is created. Skipping a cycle is recoverable; an undeletable duplicate
  is not.

No LLM judgment participates in the uniqueness decision.

## Agent pipeline funnel

A SigNoz **trace funnel** models an agent run as `invoke_agent → tool_call →
generate` (Mastra's native trace spans) and measures conversion / drop-off per
phase — observability that only makes sense for an agent. Versioned at
[`deploy/signoz/funnels/`](deploy/signoz/funnels/) with its create/caveat notes.

## Telemetry-driven failover — SigNoz as a runtime input

Most of this doc is about *seeing* the agent. This part is about the agent
*acting on what it sees*. `createModel()` (`src/mastra/model.ts`) consults
`src/mastra/model-health.ts` before every turn; when the configured primary
provider is degraded it **fails over to the fallback on its own** and records the
decision as a `model_failover` span. SigNoz stops being a dashboard you read and
becomes an input the system runs on — "if you can't observe your agent you don't
own it", closed all the way to the agent changing its own behaviour.

Two health signals, combined, **always fail-open** (a health check must never
fail — or even slow — a real request):

- **Local rolling window** (this process). The LLM telemetry middleware already
  observes every call's success/error inline; each outcome is recorded into a
  per-provider ring buffer (`noteLlmOutcome`). Zero network, always available —
  the circuit breaker that actually protects the hot path. Trips on a real burst
  of failures (kill the provider → real errors → trip).
- **SigNoz query** (cross-replica). A background poll (≤ every 60s, off the hot
  path) reads the provider's OWN `model_generation` error-rate + p95 back out of
  SigNoz via `POST /api/v5/query_range`, filtered to
  `casper.self_instrumented = true` (so it counts our cost-bearing spans, never
  the duplicate exporter rows). This is the "reads its own telemetry" signal — a
  verdict informed by the whole fleet, not just this pod. It speaks the **same
  v2alpha1 builder dialect** as the versioned dashboards and alerts, so the
  failover verdict and the panels an operator reads can't drift apart. Override
  the path with `SIGNOZ_QUERY_PATH` if the API moves.

`createModel()` only ever DOWNGRADES to a *configured* fallback (creds present),
never fails a request; any error in the health path builds the primary unchanged.
The switch emits a `model_failover` span (`model.failover.from/to/source/reason`),
which lights up two dashboard panels (`Model failovers`, `Failovers by target &
trigger`) and `deploy/signoz/alerts/model-failover.json`.

Env (all optional; absent → feature is inert, primary always used):

```bash
# The SigNoz query signal needs a queryable instance + a service-account key
# (reuses the SRE-copilot's vars):
SIGNOZ_INSTANCE_URL=http://signoz-signoz-0:8080
SIGNOZ_MCP_API_KEY=<signoz-service-account-key>

# Tuning (defaults shown):
MODEL_HEALTH_ERROR_RATE_THRESHOLD=0.5    # ≥50% errors in window → degraded
MODEL_HEALTH_MIN_SAMPLES=4               # don't trip on 1–3 calls
MODEL_HEALTH_P95_MS_THRESHOLD=30000      # ≥30s p95 → degraded (mirrors the alert)
MODEL_HEALTH_WINDOW_MS=120000            # local window (2 min)
MODEL_HEALTH_REFRESH_MS=60000            # SigNoz poll cadence
MODEL_HEALTH_DISABLED=1                  # kill switch (always healthy)

# Demo: force a deterministic failover on stage without breaking a provider.
MODEL_HEALTH_FORCE_DEGRADED=fireworks    # or "1"/"true" for whatever is primary
```

### Verify the SigNoz signal against a live instance

The `query_range` signal fails open by design, which means a rejected query shape
and an idle window both look like "no verdict" — so a broken query would be
silent, and the local breaker would quietly carry every decision. Verify it
explicitly instead of assuming:

```bash
SIGNOZ_INSTANCE_URL=http://localhost:8090 \
SIGNOZ_MCP_API_KEY=<service-account-key> \
DEPLOYMENT_ENVIRONMENT=development \
pnpm verify:signoz
```

It prints the exact request body, runs it for both providers, and exits non-zero
if the query is **rejected** (HTTP 4xx → wrong shape) or the response is
**unreadable** (200 but no parseable aggregate). "No traffic in the window" exits
0 as INCONCLUSIVE — drive the agent, then re-run for an end-to-end pass. The
same discriminator is available at runtime via `lastSignozProbe(provider)`.

> **Demo, honest.** The local signal + `MODEL_HEALTH_FORCE_DEGRADED` make the
> failover reproducible on stage: set the env, send a chat, watch the trace carry
> a `model_failover` span and the answer come back on Bedrock. Note that
> `MODEL_HEALTH_FORCE_DEGRADED` short-circuits the health check before either
> signal runs — so run `pnpm verify:signoz` too if you want proof the
> cross-replica SigNoz path itself works, not just the forced demo path. Needs a
> configured fallback (`MODEL_PROVIDER=fireworks` primary + Bedrock creds, or
> vice-versa) or there's nowhere to fail over to.

## Verify traces land

```bash
pnpm dev            # app :3001, now exporting to SigNoz
# drive the agent (send a chat / process a meeting), then open the UI:
open http://localhost:8090   # Traces → service `casper-assistant`
```

Service name is `casper-assistant` (set in `observability.ts`). To see the logs
signal + correlation: trigger a failure (e.g. an invalid model or a tool error),
then in **Logs** filter `gen_ai.operation.name EXISTS` — each row shows a
`traceId`/`spanId`; click through to land on the exact failing span in **Traces**.

## Reference

SigNoz OSS source (for query-builder / API schema lookups):
<https://github.com/SigNoz/signoz>. MCP server:
<https://signoz.io/docs/ai/signoz-mcp-server/>.
