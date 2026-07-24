# SigNoz Observability

OpenTelemetry-native observability for the CasperAgent agent stack (Mastra +
Vercel AI SDK + Claude Agent SDK). Agent spans — tool calls, LLM generations,
RAG hops, Inngest workflows — plus Mastra log events are exported over OTLP
(`http/protobuf`) to a SigNoz instance. Token/cost/latency ride along as span
attributes (`gen_ai.usage.*`, span durations); Mastra's auto-extracted *metrics*
are NOT sent over OTLP (the OtelExporter forwards only traces + logs), so
cost/latency dashboards in SigNoz are built from traces, not a metrics pipeline.

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
service-account key (`SIGNOZ-API-KEY` header).

1. **Create a service account key** (once, as an admin) — SigNoz UI →
   *Settings → Service Accounts* → create account (editor role) → create key.
   Or via API: `POST /api/v1/service_accounts` → `POST /api/v1/service_accounts/{id}/keys`.
2. **Push the dashboard** — `POST /api/v2/dashboards` with the versioned JSON
   ([`deploy/signoz/dashboards/agent-llm-observability.json`](deploy/signoz/dashboards/agent-llm-observability.json)).
   The body is `{ schemaVersion, name (RFC-1123 slug), tags:[{key,value}], spec }`
   — the JSON's `spec` (display, variables, panels, layouts) is used as-is.
3. **Push the alert rules** — `POST /api/v2/rules` per file under
   [`deploy/signoz/alerts/`](deploy/signoz/alerts/); `POST /api/v2/rules/test`
   dry-runs one before saving.

Panels populate once `gen_ai.*` traces are ingested (drive the agent first).

## Real LLM cost (not a placeholder)

The dashboard cost panels read `gen_ai.usage.cost` — a real $ figure the app
computes per span from token counts, not an estimate. Set both prices (per 1M
tokens) so every model_generation span carries its cost:

```bash
# Kimi K2.7 Code on Fireworks (the default model). Adjust per your model.
LLM_PRICE_INPUT_PER_MTOK=0.95
LLM_PRICE_OUTPUT_PER_MTOK=4.00
```

Absent → the cost field is simply empty (no fabricated number). See
`src/mastra/llm-telemetry.ts` (`pricePerToken`). Note: SigNoz's own native
per-span cost processor (`signozllmpricing`, `_signoz.gen_ai.total_cost`) is
**EE/Cloud-only** — it is not in the OSS collector image, so on self-host OSS the
app-side computation above is the way to get real cost.

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

## Agent pipeline funnel

A SigNoz **trace funnel** models an agent run as `invoke_agent → tool_call →
generate` (Mastra's native trace spans) and measures conversion / drop-off per
phase — observability that only makes sense for an agent. Versioned at
[`deploy/signoz/funnels/`](deploy/signoz/funnels/) with its create/caveat notes.

## Verify traces land

```bash
pnpm dev            # app :3001, now exporting to SigNoz
# drive the agent (send a chat / process a meeting), then open the UI:
open http://localhost:8090   # Traces → service `casper-assistant`
```

Service name is `casper-assistant` (set in `observability.ts`).

## Reference

SigNoz OSS source (for query-builder / API schema lookups):
<https://github.com/SigNoz/signoz>. MCP server:
<https://signoz.io/docs/ai/signoz-mcp-server/>.
