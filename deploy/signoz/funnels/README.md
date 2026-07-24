# Agent pipeline funnel (SigNoz trace funnels)

A **trace funnel** models an agent run as an ordered sequence of phases in one
trace and measures **conversion / drop-off** between them — observability that
only makes sense for an agent, not a plain web request.

`agent-pipeline-funnel.json` defines:

```
invoke_agent  →  tool_call  →  generate
 (agent_run)     (tool_call)    (model_inference)
```

It targets **Casper Assistant** — the product agent real users talk to (schedule
bots, list calendar, create meetings) — NOT the internal SRE-copilot. The span
names embed the agent's name (`invoke_agent Casper Assistant`,
`model_inference Casper Assistant`), so a funnel measures ONE agent; this is the
one that matters for the product. (An earlier version pinned to the SRE copilot,
which no real user traffic hits — the funnel read as the general pipeline but
measured only self-observability. Fixed.)

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

## Robust alternative: the dashboard conversion panels

The SigNoz funnel FEATURE is span-name-bound (see caveat below), so it can't be
made rename-proof. For a robust, attribute-only view of the same pipeline, the
dashboard (`../dashboards/agent-llm-observability.json`) carries a **Pipeline
conversion** row that reproduces the funnel WITHOUT the fragility:

- runs → reached-tool → reached-generation, each a `count_distinct(trace_id)`
  matched on the stable OTel `gen_ai.operation.name` attribute
  (`invoke_agent` / `execute_tool` / `chat`), plus `casper.self_instrumented`
  on the generate step to skip the duplicate native span;
- two conversion-% tiles (`(B/A)*100`) and a drop-off time series.

Because it matches on the semconv attribute, not the display name, it counts
EVERY tool (not one hardcoded tool) and survives agent/tool/model renames. Verified
live via the query API (tool conversion resolved to a real %). Prefer these panels
for the trustworthy number; keep the funnel below for the SigNoz UI's native
funnel visualization.

## Caveats (honest)

- **Step match is by exact `span_name`**, not by attribute. SigNoz's funnel query
  matches `service_name = X AND name = <span_name>`; the per-step `filters` are a
  secondary refinement, not the primary match (verified against SigNoz v0.134: the
  funnel steps API doesn't accept an attribute-only step — hence the dashboard
  panels above for the robust view). Mastra's local tool spans are named
  `execute_tool <toolId>`, so step 2 is pinned to one representative tool on the
  assistant's common path (`list_calendar_events`). A truly tool-agnostic step 2
  would need a stable per-phase span name (e.g. emitting an `agent.tool_phase`
  span) — a small instrumentation add, noted as future work. Note `mastra.span.type`
  is `tool_call` for the assistant's local tools (it was `mcp_tool_call` in the
  old SRE-copilot version, whose tools were all MCP).
- **Confirm the exact `span_name` against a live trace before importing.** The
  names above are derived from `@mastra/otel-exporter`'s naming
  (`<operation> <entityName>`), but the surest check is to open one Casper
  Assistant trace in **Traces**, read the real span names off the waterfall, and
  paste them in. A one-character mismatch = the step silently never matches.
- On **self-host OSS**, the `analytics/overview` endpoint currently returns a
  serialization error (`unsupported value: NaN`) when conversion is a clean
  100% (no drop-off in the sample window) — a SigNoz OSS bug, not a funnel-spec
  problem. It resolves once the window contains runs that drop off mid-funnel.
  `slow-traces` / the UI funnel view work regardless.
