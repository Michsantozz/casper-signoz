# SigNoz Observability

OpenTelemetry-native observability for the CasperAgent agent stack (Mastra +
Vercel AI SDK + Claude Agent SDK). Agent spans — tool calls, LLM generations,
RAG hops, Inngest workflows — plus token/cost/latency metrics are exported over
OTLP to a SigNoz instance.

SigNoz has **no proprietary SDK**: the app speaks standard OTel, SigNoz just
receives it via OTLP. Same spans already feed Langfuse and PG; SigNoz is an
additional, independent sink (all three can run at once).

## Wiring (already in the codebase)

- `src/mastra/observability.ts` — adds `OtelExporter` (`@mastra/otel-exporter`)
  to the Mastra `Observability` when SigNoz env is set. Two modes:
  - **Self-host**: `SIGNOZ_ENDPOINT` set, no key → OTLP `custom` provider
    (`http/protobuf`, no ingestion header).
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

```bash
# 1. install foundryctl
curl -fsSL https://signoz.io/foundry.sh | bash

# 2. minimal casting.yaml
cat > casting.yaml <<'YAML'
apiVersion: v1alpha1
kind: Installation
metadata:
  name: signoz
spec:
  deployment:
    flavor: compose
    mode: docker
YAML

# 3. deploy (validates docker, generates compose in pours/deployment/, starts)
foundryctl cast -f casting.yaml
```

Ports:
- **UI** → http://localhost:8080
- **OTLP ingest** → 4317 (gRPC) / 4318 (HTTP)
- **MCP server** → 8000 (optional; enable via `mcp.spec.enabled: true` in
  `casting.yaml` — used for the SRE-copilot idea, agent queries its own
  telemetry).

> Needs ~4GB RAM allocated to Docker. Containers healthy in ~1 min.

## Verify traces land

```bash
pnpm dev            # app :3001, now exporting to SigNoz
# drive the agent (send a chat / process a meeting), then open the UI:
open http://localhost:8080   # Traces → service `casper-assistant`
```

Service name is `casper-assistant` (set in `observability.ts`).

## Reference

Local clone of the SigNoz repo for code/docs lookups: `/home/michsantoz/signoz-ref`.
