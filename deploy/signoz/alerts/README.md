# SigNoz alerts (versioned)

Canonical SigNoz alert rules (`schemaVersion: v2alpha1`, `threshold_rule`,
rolling evaluation) over the OTLP traces **and metrics** the app exports. One
rule per file.

Three rule families ship: **traces-based** (aggregate over span attributes — work
even if only traces flow), **metric-based** (read the first-class OTel metrics the
app exports via the metrics pipeline — no derived-cost placeholder, metric-native
evaluation), and **logs-based** (`llm-error-logs.json` — reads the correlated ERROR
log records the app emits at each failure, directly off the logs signal). The
metric twins are preferred once the metrics pipeline is confirmed flowing; the
traces rules stay as a fallback. The logs rule is the failure alert with the
tightest pivot: each matching log carries the failing span's traceId+spanId, so
from the alert you jump to the exact span in the waterfall.

| File | Signal | Fires when | Group by |
|------|--------|-----------|----------|
| `llm-latency-p95.json` | traces | `p95(duration_nano)` of `model_generation` spans > 30s (30000000000 ns) | `gen_ai.request.model` |
| `llm-latency-p95-metric.json` | **metric** | `p95` of `gen_ai.client.operation.duration` histogram (op = chat) > 30s | — |
| `llm-cost-spike.json` | traces | derived cost (formula over token sums) > $5 in the window | — |
| `llm-cost-spike-metric.json` | **metric** | `increase` of `gen_ai.client.operation.cost` counter (real USD) > $5 in the window | — |
| `tool-call-failures.json` | traces | `count()` of `tool_call` spans with `error.type` > 5 in the window | `gen_ai.tool.name` |
| `llm-error-logs.json` | **logs** | `count()` of correlated ERROR log records (`gen_ai.operation.name EXISTS`) > 5 in the window | `gen_ai.operation.name` |
| `answer-quality-low.json` | traces | avg answer completeness below target | — |
| `health-watch-down.json` | traces | any `health_watch` span with `mastra.health_watch.ok = false` | `error.type` |

Most use a 5m rolling window, 1m frequency, `matchType: at_least_once`, and
`renotify` on the `firing` state. Adjust `target`, `evalWindow`, `frequency`,
and severity labels to taste.

**`health-watch-down.json` is the exception, deliberately.** It watches the
watchdog: the autonomous health-watch cron that queries SigNoz on a `*/15`
schedule. Every other rule here fires on telemetry the agent *produces*, so if
the self-observing loop breaks they fall silent rather than firing — silence
stops being evidence of health. Its window is 30m/5m (a `*/15` cron only gets
~2 chances per window) and its target is `> 0`: a single failed pass is the
signal, since the span is only emitted on failure.

## Notify channel

`notificationSettings.usePolicy: false` means these rules use their thresholds'
`channels` (none set here) / the default routing. To route to Slack/webhook/
email/PagerDuty/Opsgenie/Teams, create the channel in SigNoz
(Settings → Alert Channels), then either set `usePolicy: true` (route policies)
or add the channel name to each threshold's `channels` array.

## Cost alert pricing

`llm-cost-spike.json` derives cost as `input_tokens * PRICE_IN + output_tokens *
PRICE_OUT` at the **real Fireworks kimi-k2p7-code rates**: `0.00000095` USD/token
input (= $0.95 / 1M) and `0.000004` USD/token output (= $4.00 / 1M). This is a
trace-side estimate (no cache-read discount → overstates on cache-heavy windows).
The metric-based twin `llm-cost-spike-metric.json` fires on the precise
`gen_ai.client.operation.cost` counter — prefer it for exact-dollar paging. If
you switch models, update both constants to your provider's per-token price.

## Create

Import via the SigNoz UI (Alerts → New alert → the query builder mirrors these
specs), or POST each file to the rules API:

```bash
# needs an admin session cookie or a service-account API key
curl -X POST http://localhost:8090/api/v2/rules \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SIGNOZ_API_KEY" \
  --data @llm-latency-p95.json
```
