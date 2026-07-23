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

## Verify traces land

```bash
pnpm dev            # app :3001, now exporting to SigNoz
# drive the agent (send a chat / process a meeting), then open the UI:
open http://localhost:8090   # Traces → service `casper-assistant`
```

Service name is `casper-assistant` (set in `observability.ts`).

## Reference

Local clone of the SigNoz repo for code/docs lookups: `/home/michsantoz/signoz-ref`.
