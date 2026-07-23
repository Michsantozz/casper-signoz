# SigNoz alerts (versioned)

Canonical SigNoz alert rules (`schemaVersion: v2alpha1`, `threshold_rule`,
rolling evaluation) over the OTLP traces the app exports. One rule per file.

| File | Fires when | Group by |
|------|-----------|----------|
| `llm-latency-p95.json` | `p95(duration_nano)` of `model_generation` spans > 30s (30000000000 ns) | `gen_ai.request.model` |
| `llm-cost-spike.json` | derived cost (formula over token sums) > $5 in the window | — |
| `tool-call-failures.json` | `count()` of `tool_call` spans with `error.type` > 5 in the window | `gen_ai.tool.name` |

All use a 5m rolling window, 1m frequency, `matchType: at_least_once`, and
`renotify` on the `firing` state. Adjust `target`, `evalWindow`, `frequency`,
and severity labels to taste.

## Notify channel

`notificationSettings.usePolicy: false` means these rules use their thresholds'
`channels` (none set here) / the default routing. To route to Slack/webhook/
email/PagerDuty/Opsgenie/Teams, create the channel in SigNoz
(Settings → Alert Channels), then either set `usePolicy: true` (route policies)
or add the channel name to each threshold's `channels` array.

## ⚠️ Cost alert uses a placeholder price

`llm-cost-spike.json` derives cost as `input_tokens * PRICE_IN + output_tokens *
PRICE_OUT`. The committed constant is a **PLACEHOLDER** `0.0000009` USD/token
(= $0.90 per 1M) for both. Replace both constants in the `F1` formula with the
real Fireworks `glm-5p2` rates before trusting the dollar threshold.

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
