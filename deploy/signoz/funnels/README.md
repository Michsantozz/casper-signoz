# Agent pipeline funnel (SigNoz trace funnels)

A **trace funnel** models an agent run as an ordered sequence of phases in one
trace and measures **conversion / drop-off** between them — observability that
only makes sense for an agent, not a plain web request.

`agent-pipeline-funnel.json` defines:

```
invoke_agent  →  tool_call  →  generate
 (agent_run)     (tool_call)    (model_inference)
```

It targets the **Meeting Search Specialist** — the product sub-agent the
supervisor delegates every meeting question to, so it sits on the path real user
traffic actually takes. The span names embed the agent's name
(`invoke_agent Meeting Search Specialist`,
`model_inference Meeting Search Specialist`), so a funnel measures ONE agent.

> **Why not the supervisor ("Casper Assistant")?** Because it emits none of
> these spans. Mastra produces `invoke_agent` / `model_inference` only for a
> **sub-agent invoked as a tool**; the top-level supervisor turn goes through
> `handleChatStream` and emits `model_chunk Casper Assistant` instead. A funnel
> pinned to `invoke_agent Casper Assistant` therefore matches **nothing** — and
> a funnel that matches nothing looks exactly like a pipeline with no traffic.
> Measured against the live instance on 2026-07-25: **0** traces in 24h carried
> `invoke_agent Casper Assistant`, while `invoke_agent Meeting Search
> Specialist` carried 5. (An even earlier version pinned to the SRE copilot,
> which only self-observability traffic hits. Both are now pinned OUT by
> `tests/unit/mastra/signoz-assets.test.ts`.)
>
> This is the span-name fragility below, biting for real: nothing errors, the
> import succeeds, the panel just reads zero. If you change agent names, re-read
> the real span names off a live trace before trusting the funnel.

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
# 0. LIST first — creating blind gives you a second funnel with the same name,
#    and re-attaching steps to the wrong one is invisible in the UI.
curl "$SIGNOZ/api/v1/trace-funnels/list" -H "SIGNOZ-API-KEY: $KEY"

# 1. create the funnel, only if the name is absent (returns funnel_id)
curl -X POST "$SIGNOZ/api/v1/trace-funnels/new" -H "SIGNOZ-API-KEY: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"funnel_name":"CasperAgent — plan → tool → generate","description":"..."}'

# 2. attach the steps (PUT; timestamp is required, ms epoch).
#    Re-running this against an EXISTING funnel_id replaces its steps, which is
#    how you converge one after the span names change.
curl -X PUT "$SIGNOZ/api/v1/trace-funnels/steps/update" -H "SIGNOZ-API-KEY: $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"funnel_id":"<id>","timestamp":<ms>,"steps": <the steps array from the json> }'
```

Then open **Traces → Funnels** in the SigNoz UI. The analytics endpoints are
`POST` only (a `GET` returns the SPA's HTML with a 200, which reads like success
until you try to parse it), and take `{"start_time": <ms>, "end_time": <ms>}` —
not `start`/`end`. `steps/overview` additionally requires `step_start` and
`step_end` (ints, matching `step_order`); without them it 500s with *"step start
and end cannot be the same"*.

**On this v0.134 self-host, only `slow-traces` returns 200.** Both `overview` and
`steps/overview` fail with `unsupported value: NaN` — measured on every step pair
including one with genuine drop-off (5→4), so the earlier note that this only
happens on a clean 100% conversion is wrong: it is not something you can dodge by
waiting for drop-off. And `slow-traces` answers `data: null` even while the steps
match real traces, so it is not proof of conversion either. **Verify the funnel
through the UI or by querying the spans directly** (`POST /api/v5/query_range`,
one query per step name, intersecting `trace_id`) — that is how the numbers below
were obtained.

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
  specialist's common path (`search_my_meetings`). A truly tool-agnostic step 2
  would need a stable per-phase span name (e.g. emitting an `agent.tool_phase`
  span) — a small instrumentation add, noted as future work. Note `mastra.span.type`
  is `tool_call` for the agent's local tools (it was `mcp_tool_call` in the
  old SRE-copilot version, whose tools were all MCP).
- **Confirm the exact `span_name` against a live trace before importing.** The
  names above are derived from `@mastra/otel-exporter`'s naming
  (`<operation> <entityName>`), but the surest check is to open one real trace in
  **Traces**, read the span names off the waterfall, and paste them in. A
  one-character mismatch = the step silently never matches. This is not
  hypothetical — it is exactly how both previous versions of this funnel shipped
  broken (first pinned to the SRE copilot, then to the supervisor, which emits no
  such span at all).
- The `analytics/*` endpoints are largely unusable on this self-host build — see
  **Create it** above for the measured behaviour. Verify through the UI or by
  querying the step spans directly.

## Verified against production

Measured on the live instance, 12h window, service `casper-assistant`
(2026-07-25), after pointing the funnel at the Meeting Search Specialist:

| step | span_name | traces |
|------|-----------|--------|
| 1 | `invoke_agent Meeting Search Specialist` | 5 |
| 2 | `execute_tool search_my_meetings` | 4 |
| 3 | `model_inference Meeting Search Specialist` | 5 |

**4 traces** carry all three in order; the 5th has step 1 and step 3 but no step 2
— a genuine mid-funnel drop-off (the agent answered without calling the tool),
which is precisely the signal this funnel exists to show. The funnel already on
the instance was still carrying the old SRE-copilot steps, so `steps/update` was
re-run against its existing `funnel_id` rather than creating a second funnel.
