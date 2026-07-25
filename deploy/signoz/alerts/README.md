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
| `answer-quality-low.json` | traces | avg answer COVERAGE below target (lexical coverage of the request, not correctness) | — |
| `model-failover.json` | traces | any `model_failover` span in the window (`count() > 0`) | `model.failover.to` |
| `health-watch-down.json` | traces | any `health_watch` span with `mastra.health_watch.ok = false` — it ran and FAILED | `error.type` |
| `health-watch-absent.json` | traces | **no** `health_watch` span at all for 45 min (`alertOnAbsent`) — it did not run AT ALL | — |

Most use a 5m rolling window, 1m frequency, `matchType: at_least_once`, and
`renotify` on the `firing` state. Adjust `target`, `evalWindow`, `frequency`,
and severity labels to taste.

**`model-failover.json`** fires the moment telemetry-driven failover kicks in:
`createModel()` read the primary provider's own health back out of SigNoz (or hit
a local error burst) and rerouted to the fallback. Like `health-watch-down`, a
single occurrence is the signal (`target > 0`) — a failover means the primary is
degraded *right now* and every turn is paying the fallback's price/latency until
it recovers. `model.failover.source` says what tripped it (`local` / `signoz` /
`forced`). See `../../../src/mastra/model-health.ts`.

**`health-watch-down.json` is the exception, deliberately.** It watches the
watchdog: the autonomous health-watch cron that queries SigNoz on a `*/15`
schedule. Every other rule here fires on telemetry the agent *produces*, so if
the self-observing loop breaks they fall silent rather than firing — silence
stops being evidence of health. Its window is 30m/5m (a `*/15` cron only gets
~2 chances per window) and its target is `> 0`: a single failed pass is the
signal.

**But `health-watch-down` alone does not close that gap — `health-watch-absent`
is the other half.** The down rule matches `mastra.health_watch.ok = false`,
which still requires the watch to be running well enough to report its own
failure. The state it can never signal is the cron not firing at all (Inngest
down, workflow unregistered, a hung pass holding the `concurrency: 1` slot) —
and that is indistinguishable from a healthy quiet window. So the watch now
emits a **heartbeat on every clean pass** too (`ok = true`, `emitWatchSpan` in
[`agent-health-watch.ts`](../../../src/server/observability/agent-health-watch.ts)),
and `health-watch-absent.json` fires on the ABSENCE of it via SigNoz's
`condition.alertOnAbsent` / `absentFor`.

Two things about that rule are worth knowing before you edit it:

- **`alertOnAbsent`/`absentFor` are not in the public SigNoz docs** at time of
  writing. They were verified against this deployment (v0.134.0) with
  `POST /api/v2/rules/test`: identical rule, no matching data → `alertCount 0`
  **without** the flag, `alertCount 1` **with** it. That zero is precisely the
  blind spot.
- **`stepInterval: 3600` is load-bearing.** Absence is evaluated per bucket, so
  the bucket must be wide enough that a healthy `*/15` watch always lands a tick
  inside it. Measured on the live instance with heartbeats present: step `900`
  and `1800` still fired (false positive); `3600` against a 1h `evalWindow`
  collapses the window to one bucket and returns 0. `absentFor` is in **seconds**
  (2700 = 45 min = three missed ticks). Re-measure both if the cron cadence
  changes.

## Notify channel

`notificationSettings.usePolicy: false` means these rules route via their own
thresholds' `channels` rather than route policies. **All ten rules set
`channels: ["casper-default"]`** (`condition.thresholds.spec[0].channels`).

SigNoz resolves that by NAME and does not create the channel, so importing
these rules into a fresh instance yields ten rules pointing at nothing. Create
it first — the definition is versioned at [`../channels/casper-default.json`](../channels/README.md),
which also covers the admin-only permission on that route.

To route somewhere else, either change the name in each threshold's `channels`
array, or set `usePolicy: true` and manage the routing with route policies.

## Cost alert pricing

`llm-cost-spike.json` derives cost as `input_tokens * PRICE_IN + output_tokens *
PRICE_OUT` at the **real Fireworks kimi-k2p7-code rates**: `0.00000095` USD/token
input (= $0.95 / 1M) and `0.000004` USD/token output (= $4.00 / 1M). This is a
trace-side estimate (no cache-read discount → overstates on cache-heavy windows).
The metric-based twin `llm-cost-spike-metric.json` fires on the precise
`gen_ai.client.operation.cost` counter — prefer it for exact-dollar paging. If
you switch models, update both constants to your provider's per-token price.

## Create

One command applies the channel, the dashboard, and every rule here, in the
order the references require:

```bash
SIGNOZ_INSTANCE_URL=http://localhost:8090 \
SIGNOZ_MCP_API_KEY=<service-account-key> \
pnpm signoz:import                 # --dry-run to validate without writing
```

It is idempotent by name (absent → create, present → update), and `--dry-run`
runs every rule through `POST /api/v2/rules/test` so a bad query expression is
caught before anything is written. `--only=alerts` restricts it to this
directory. See [`scripts/signoz-import.ts`](../../../scripts/signoz-import.ts).

The manual path still works if you prefer it — POST each file to the rules API:

```bash
curl -X POST http://localhost:8090/api/v2/rules \
  -H 'Content-Type: application/json' \
  -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" \
  --data @llm-latency-p95.json
```
