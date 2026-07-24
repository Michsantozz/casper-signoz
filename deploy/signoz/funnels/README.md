# Agent pipeline funnel (SigNoz trace funnels)

A **trace funnel** models an agent run as an ordered sequence of phases in one
trace and measures **conversion / drop-off** between them — observability that
only makes sense for an agent, not a plain web request.

`agent-pipeline-funnel.json` defines:

```
invoke_agent  →  tool_call  →  generate
 (agent_run)    (mcp_tool_call)  (model_inference)
```

These are Mastra's **native** trace spans (all on service `casper-assistant`,
parented under the same `agent_run` trace), so no extra instrumentation is
needed — the phases already exist in every agent run. The funnel answers:

- What % of agent runs actually reach a tool call vs. answer directly?
- What % of tool calls reach a final generation (vs. erroring mid-run)?
- p95 latency of the whole plan→generate critical path.
- Which traces are the slowest / which errored between two phases.

## Create it

Trace funnels are created over the REST API (same service-account key as the
dashboard/alerts):

```bash
# 1. create the funnel (returns funnel_id)
curl -X POST "$SIGNOZ/api/v1/trace-funnels/new" -H "SIGNOZ-API-KEY: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"funnel_name":"CasperAgent — plan → tool → generate","description":"..."}'

# 2. attach the steps (PUT; timestamp is required, ms epoch)
curl -X PUT "$SIGNOZ/api/v1/trace-funnels/steps/update" -H "SIGNOZ-API-KEY: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"funnel_id":"<id>","timestamp":<ms>,"steps": <the steps array from the json> }'
```

Then open **Traces → Funnels** in the SigNoz UI, or query
`POST /api/v1/trace-funnels/{id}/analytics/{overview,steps/overview,slow-traces}`.

## Caveats (honest)

- **Step match is by exact `span_name`**, not by attribute. SigNoz's funnel query
  matches `service_name = X AND name = <span_name>`; the per-step `filters` are a
  secondary refinement, not the primary match. Mastra's tool spans are named
  `execute_tool <tool>`, so step 2 here is pinned to one representative tool
  (`signoz_signoz_aggregate_traces`). A truly tool-agnostic step 2 would need a
  stable per-phase span name (e.g. emitting an `agent.tool_phase` span) — a small
  instrumentation add, noted as future work.
- On **self-host OSS**, the `analytics/overview` endpoint currently returns a
  serialization error (`unsupported value: NaN`) when conversion is a clean
  100% (no drop-off in the sample window) — a SigNoz OSS bug, not a funnel-spec
  problem. It resolves once the window contains runs that drop off mid-funnel.
  `slow-traces` / the UI funnel view work regardless.
