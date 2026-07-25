import "server-only";

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getSignozTracer } from "@/mastra/llm-telemetry";

// ════════════════════════════════════════════════════════════════════════
// Telemetry-driven model health → automatic failover.
//
// The creative core: SigNoz stops being a passive dashboard and becomes a
// RUNTIME INPUT. `createModel()` consults this module before every agent turn;
// when the primary provider is unhealthy it fails over to the fallback on its
// own. The system acts on what it can see about itself.
//
// TWO independent health signals, combined, ALWAYS fail-open (a health-check
// failure must never break — or even slow — a real request):
//
//   1. LOCAL rolling window (this process). The LLM telemetry middleware already
//      observes every call's success/error inline; we record that outcome into a
//      per-provider ring buffer here. Zero network, always available — this is
//      the circuit breaker that actually protects the hot path. Trips on a real
//      burst of consecutive failures (kill the provider → real errors → trip).
//
//   2. SigNoz query (cross-replica, cross-run). A background poll (≤ every
//      REFRESH_MS) reads the provider's OWN model_generation error-rate + p95
//      back out of SigNoz over the query API. This is the "reads its own
//      telemetry" story — a verdict informed by the whole fleet, not just this
//      pod. Best-effort: if the query errors or the instance isn't wired, this
//      signal is simply absent and the local one carries the decision.
//
// Both are advisory. `createModel()` only ever DOWNGRADES to a configured
// fallback; it never fails a request outright, and if everything here throws the
// caller still gets the primary model.
// ════════════════════════════════════════════════════════════════════════

export type Provider = "fireworks" | "bedrock";

function num(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Local rolling window: how far back outcomes count toward the error rate.
const WINDOW_MS = num("MODEL_HEALTH_WINDOW_MS", 120_000); // 2 min
// Don't trip on a single stray error — require a minimum sample size first.
const MIN_SAMPLES = num("MODEL_HEALTH_MIN_SAMPLES", 4);
// Fraction of failed calls in the window that marks a provider degraded.
const ERROR_RATE_THRESHOLD = num("MODEL_HEALTH_ERROR_RATE_THRESHOLD", 0.5);
// p95 latency (ms) over the SigNoz window that marks a provider degraded. Mirrors
// the llm-latency-p95 alert threshold so the failover and the alert agree.
const P95_MS_THRESHOLD = num("MODEL_HEALTH_P95_MS_THRESHOLD", 30_000);
// Background SigNoz poll cadence. The hot path NEVER waits on this — it reads the
// last cached verdict and (if stale) kicks off a refresh without awaiting it.
const REFRESH_MS = num("MODEL_HEALTH_REFRESH_MS", 60_000);
// How much recent history the SigNoz query aggregates over.
const SIGNOZ_LOOKBACK_MS = num("MODEL_HEALTH_SIGNOZ_LOOKBACK_MS", 600_000); // 10 min

// Kill switch — set to disable failover entirely (always report healthy).
const DISABLED = process.env.MODEL_HEALTH_DISABLED === "1";
// Demo/override: force the primary to read as degraded so a failover is
// deterministic on stage even without actually breaking the provider. Accepts a
// provider name (force just that one) or "1"/"true" (force whatever is primary).
const FORCE_DEGRADED = process.env.MODEL_HEALTH_FORCE_DEGRADED;

// ── Local outcome ring buffer ───────────────────────────────────────────────
//
// One bounded array of recent {at, ok} per provider. Pruned on every read/write
// to WINDOW_MS, and hard-capped so a hot loop can't grow it without bound.
const MAX_SAMPLES = 500;
type Outcome = { at: number; ok: boolean };
const outcomes: Record<Provider, Outcome[]> = {
  fireworks: [],
  bedrock: [],
};

function prune(list: Outcome[], now: number): Outcome[] {
  const cutoff = now - WINDOW_MS;
  // Drop anything older than the window; keep the tail bounded.
  let i = 0;
  while (i < list.length && list[i].at < cutoff) i++;
  const pruned = i > 0 ? list.slice(i) : list;
  return pruned.length > MAX_SAMPLES
    ? pruned.slice(pruned.length - MAX_SAMPLES)
    : pruned;
}

// Map an ai-sdk provider string to our failover enum. The wrapped models report
// `model.provider` as "amazon-bedrock" (Bedrock) or "openai.chat" (the Fireworks
// OpenAI-compatible client) — NOT "fireworks"/"bedrock" — so normalize by
// substring. Anything that isn't clearly Bedrock is treated as the Fireworks
// (OpenAI-compat) path, which is the only other provider this app wires.
export function normalizeProvider(provider: string): Provider {
  return provider.toLowerCase().includes("bedrock") ? "bedrock" : "fireworks";
}

// The value the provider actually lands in `gen_ai.provider.name` on a span —
// what the SigNoz query must filter on (see normalizeProvider for why these
// differ from the enum). Overridable via env if a provider swap changes it.
const PROVIDER_SPAN_VALUE: Record<Provider, string> = {
  fireworks: process.env.MODEL_HEALTH_FIREWORKS_SPAN_PROVIDER ?? "openai.chat",
  bedrock: process.env.MODEL_HEALTH_BEDROCK_SPAN_PROVIDER ?? "amazon-bedrock",
};

// Record one LLM call outcome for a provider. Called by the telemetry middleware
// (llm-telemetry.ts) after every generate/stream, so the local signal tracks the
// exact calls SigNoz sees. Cheap and synchronous; never throws.
export function noteLlmOutcome(provider: string, ok: boolean): void {
  const p = normalizeProvider(provider);
  const now = Date.now();
  const next = prune(outcomes[p], now);
  next.push({ at: now, ok });
  outcomes[p] = next;
}

// Local error rate over the window, plus the sample count that produced it.
function localSignal(provider: Provider): { rate: number; samples: number } {
  const list = prune(outcomes[provider], Date.now());
  outcomes[provider] = list;
  if (list.length === 0) return { rate: 0, samples: 0 };
  const errors = list.reduce((n, o) => n + (o.ok ? 0 : 1), 0);
  return { rate: errors / list.length, samples: list.length };
}

// ── SigNoz query signal (background, best-effort) ───────────────────────────
//
// Reads the provider's own recent model_generation health back out of SigNoz.
// Cached per provider; refreshed at most every REFRESH_MS, off the hot path.

export type SignozHealth = {
  errorRate: number;
  p95Ms: number;
  samples: number;
};
type CacheEntry = { at: number; value: SignozHealth | null };
const signozCache = new Map<Provider, CacheEntry>();
const inFlight = new Map<Provider, Promise<SignozHealth | null>>();

function signozConfigured(): boolean {
  return Boolean(process.env.SIGNOZ_INSTANCE_URL && process.env.SIGNOZ_MCP_API_KEY);
}

// The environment this process stamps on its own spans — the same resolution
// order llm-telemetry.ts uses for the OTel resource, so the query filters on
// exactly what this deployment emits.
function deploymentEnvironment(): string {
  return (
    process.env.DEPLOYMENT_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development"
  );
}

// Build the query_range body: an aggregation over the app's own
// self-instrumented model_generation spans for one provider, returning total
// count, error count, and p95 duration in the lookback window. Filters on
// `casper.self_instrumented = true` so it counts ONLY our cost-bearing spans and
// never the duplicate @mastra/otel-exporter rows (see llm-telemetry.ts).
//
// DIALECT: this speaks the SAME v2alpha1 builder shape as the versioned
// dashboards and alert rules (deploy/signoz/) — `queries[].spec` with a string
// `filter.expression` and an `aggregations[]` array. It previously used the
// older v4 `compositeQuery.builderQueries` shape (`aggregateOperator`, filter
// objects with a bare `{key}` and no `fieldContext`). That dialect was never
// executed against a live instance, while the v2alpha1 assets demonstrably
// import and render — so the failover's cross-replica signal now rides the one
// shape this project has actually proven. Sharing a dialect with the dashboards
// also means the failover verdict and the panels an operator reads cannot drift
// apart: same filter string, same de-dup marker, same numbers.
export function buildSignozHealthQuery(provider: Provider, now: number) {
  const start = now - SIGNOZ_LOOKBACK_MS;
  // Identical predicate to deploy/signoz/alerts/llm-latency-p95.json, plus the
  // provider pin. Written as an expression string (v2alpha1) rather than filter
  // objects, so no per-key `fieldContext`/`dataType` metadata has to be guessed:
  // the backend parses the expression and resolves resource vs tag itself.
  const baseFilter =
    `service.name = 'casper-assistant'` +
    ` AND deployment.environment.name = '${deploymentEnvironment()}'` +
    ` AND mastra.span.type = 'model_generation'` +
    ` AND casper.self_instrumented = true` +
    ` AND gen_ai.provider.name = '${PROVIDER_SPAN_VALUE[provider]}'`;

  const mk = (
    name: string,
    expression: string,
    filter: string = baseFilter,
  ) => ({
    type: "builder_query",
    spec: {
      name,
      signal: "traces",
      stepInterval: 60,
      disabled: false,
      filter: { expression: filter },
      aggregations: [{ expression }],
    },
  });

  return {
    // Required by /api/v5/query_range. Without it the body is parsed against a
    // different schema and the builder specs below are not understood.
    schemaVersion: "v1",
    start,
    end: now,
    // "scalar" collapses each query to a single aggregate over the window,
    // which is exactly the shape this consumer wants (one number per query).
    requestType: "scalar",
    compositeQuery: {
      // ONLY `queries` belongs here. The v4 dialect's `queryType: "builder"` and
      // `panelType: "table"` are rejected outright — the API answers HTTP 400
      // `unknown field "queryType" in composite query / Valid fields are:
      // queries`. That 400 was live until `pnpm verify:signoz` was first able to
      // run: every unit fixture for this builder was derived from the builder
      // itself, so request and response agreed by construction and nothing ever
      // touched the real contract. A rejected query surfaces as a silent `null`,
      // i.e. the failover's cross-replica signal was permanently absent and the
      // local circuit breaker was silently carrying every decision.
      queries: [
        // A = all model_generation calls for this provider in the window
        mk("A", "count()"),
        // B = same, narrowed to spans that carry an error
        mk("B", "count()", `${baseFilter} AND error.type EXISTS`),
        // C = p95 span duration (ns) over the same set
        mk("C", "p95(duration_nano)"),
      ],
    },
  };
}

function toFiniteNumber(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(n) ? n : undefined;
}

// Pull the aggregate for `queryName` out of ONE result entry, trying every point
// shape SigNoz has returned across versions: `{value}` objects, Prometheus-style
// [timestamp, value] tuples, a bare numeric, table rows keyed by query name, and
// a top-level `value`.
function valueFromResultEntry(
  entry: unknown,
  queryName: string,
): number | undefined {
  const row = entry as {
    value?: unknown;
    columns?: Array<{ name?: string; queryName?: string }>;
    data?: unknown;
    series?: Array<{ values?: Array<unknown> }>;
    table?: {
      rows?: Array<{ data?: Record<string, unknown> }>;
    };
    rows?: Array<{ data?: Record<string, unknown> }>;
    aggregations?: Array<{
      series?: Array<{ values?: Array<unknown> }>;
      rows?: Array<{ data?: Record<string, unknown> }>;
    }>;
  };
  if (!row || typeof row !== "object") return undefined;

  // The shape /api/v5/query_range actually returns for `requestType: "scalar"`,
  // captured from a live instance: `columns[]` describes the tuple layout and
  // `data` is a matrix of rows. The column's `name` is POSITIONAL
  // (`__result_0`) — the query it belongs to is in its `queryName`, so match on
  // that first. Checking `name` too covers a table envelope that labels its
  // columns by query name directly.
  const columns = row.columns;
  if (Array.isArray(columns) && Array.isArray(row.data)) {
    const index = columns.findIndex(
      (column) => column?.queryName === queryName || column?.name === queryName,
    );
    if (index >= 0) {
      const lastRow = row.data.at(-1);
      const cell = Array.isArray(lastRow)
        ? lastRow[index]
        : (lastRow as Record<string, unknown> | undefined)?.[
            columns[index]?.name ?? queryName
          ];
      const fromMatrix = toFiniteNumber(cell);
      if (fromMatrix !== undefined) return fromMatrix;
    }
  }

  const point = row.series?.[0]?.values?.slice(-1)?.[0];
  const fromPoint =
    toFiniteNumber((point as { value?: unknown } | undefined)?.value) ??
    (Array.isArray(point) ? toFiniteNumber(point.at(-1)) : undefined) ??
    toFiniteNumber(point);
  if (fromPoint !== undefined) return fromPoint;

  // Table/scalar envelopes: the aggregate lives in a row keyed by query name.
  // `rows` appears both nested under `table` and flat, depending on version.
  const rows = row.table?.rows ?? row.rows;
  const fromRow = toFiniteNumber(rows?.slice(-1)?.[0]?.data?.[queryName]);
  if (fromRow !== undefined) return fromRow;

  // v2alpha1 nests per-aggregation results one level deeper.
  for (const agg of row.aggregations ?? []) {
    const aggPoint = agg.series?.[0]?.values?.slice(-1)?.[0];
    const fromAgg =
      toFiniteNumber((aggPoint as { value?: unknown } | undefined)?.value) ??
      (Array.isArray(aggPoint) ? toFiniteNumber(aggPoint.at(-1)) : undefined) ??
      toFiniteNumber(aggPoint) ??
      toFiniteNumber(agg.rows?.slice(-1)?.[0]?.data?.[queryName]);
    if (fromAgg !== undefined) return fromAgg;
  }

  return toFiniteNumber(row.value);
}

// Extract a single numeric result value from SigNoz's (verbose, version-drifting)
// query_range response. A parse miss = signal absent = fail-open, never a throw.
//
// THE ENVELOPE, as captured from a live instance (v5, `requestType: "scalar"`)
// — not as previously imagined here:
//
//   { status, data: { type: "scalar", meta: {…},
//       data: { results: [ { queryName: "B",
//                            columns: [{ name: "__result_0", queryName: "B",
//                                        columnType: "aggregation" }],
//                            data: [[0]] }, … ] } } }
//
// Three details, each of which broke an earlier assumption:
//   1. Results live at `data.data.results` — one level deeper than the
//      `data.result` this parser used to read, so EVERY lookup returned
//      undefined.
//   2. Queries do NOT collapse into one entry. Each gets its own entry, tagged
//      with `queryName` — the previous comment asserted the opposite.
//   3. Entries come back OUT OF ORDER (B before A above), so positional
//      indexing into `results` is wrong; match on `queryName`.
//
// The consequence of (1) was invisible: `total` fell to 0, fetchSignozHealth's
// `if (total <= 0) return null` reported "no traffic", and an absent signal is
// indistinguishable from an idle window — so the local breaker silently carried
// every decision. Nothing caught it because the unit fixtures were written from
// this parser rather than from a response; `pnpm verify:signoz` is what finally
// executed it against a real instance.
//
// Order of attempts: the tagged entry first, then a scan of every entry for a
// column carrying `queryName`. The graph/table paths remain as fallbacks.
export function pickSignozQueryValue(
  json: unknown,
  queryName: string,
): number | undefined {
  try {
    const payload = json as {
      data?: {
        result?: unknown[];
        results?: unknown[];
        data?: { result?: unknown[]; results?: unknown[] };
      };
      result?: unknown[];
    };
    // The live envelope nests one level deeper than the older dialects:
    // `data.data.results`, with `data.type`/`data.meta` as siblings of the inner
    // `data`. The shallower paths stay as fallbacks for the graph/table shapes.
    const result =
      payload?.data?.data?.results ??
      payload?.data?.data?.result ??
      payload?.data?.result ??
      payload?.data?.results ??
      payload?.result;
    if (!Array.isArray(result)) return undefined;

    // Preferred: an entry explicitly tagged with this query name (graph shape).
    const tagged = result.find(
      (r) =>
        ((r as { queryName?: string; query_name?: string })?.queryName ??
          (r as { query_name?: string })?.query_name) === queryName,
    );
    if (tagged) {
      const value = valueFromResultEntry(tagged, queryName);
      if (value !== undefined) return value;
    }

    // Fallback: untagged/collapsed entries (table + scalar shape). Scan them all
    // for a column carrying this query name.
    for (const entry of result) {
      const value = valueFromResultEntry(entry, queryName);
      if (value !== undefined) return value;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Why the last SigNoz fetch produced no verdict. The signal being ABSENT is a
// legitimate, expected state (idle window), which is exactly what made the
// broken-parser bug invisible: "query shape rejected" and "no traffic" both
// surfaced as a silent null. Recording the discriminator makes the two
// distinguishable — read it via lastSignozProbe() (the verify script prints it,
// and it never affects the fail-open decision path).
export type SignozProbe = {
  at: number;
  provider: Provider;
  ok: boolean;
  reason:
    | "unconfigured"
    | "http_error"
    | "unparseable"
    | "no_traffic"
    | "ok"
    | "network_error";
  status?: number;
  detail?: string;
};

const lastProbe = new Map<Provider, SignozProbe>();

/** Diagnostics for the most recent SigNoz health query for a provider. */
export function lastSignozProbe(provider: Provider): SignozProbe | undefined {
  return lastProbe.get(provider);
}

/** The URL the health query POSTs to. Path is overridable if the API moves. */
export function signozQueryUrl(): string | undefined {
  if (!process.env.SIGNOZ_INSTANCE_URL) return undefined;
  const base = process.env.SIGNOZ_INSTANCE_URL.replace(/\/+$/, "");
  const path = process.env.SIGNOZ_QUERY_PATH ?? "/api/v5/query_range";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchSignozHealth(
  provider: Provider,
): Promise<SignozHealth | null> {
  const note = (probe: Omit<SignozProbe, "at" | "provider">) => {
    lastProbe.set(provider, { at: Date.now(), provider, ...probe });
  };

  if (!signozConfigured()) {
    note({ ok: false, reason: "unconfigured" });
    return null;
  }
  const url = signozQueryUrl()!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "SIGNOZ-API-KEY": process.env.SIGNOZ_MCP_API_KEY!,
        ...(process.env.SIGNOZ_INSTANCE_URL
          ? { "X-SigNoz-URL": process.env.SIGNOZ_INSTANCE_URL }
          : {}),
      },
      body: JSON.stringify(buildSignozHealthQuery(provider, Date.now())),
      signal: controller.signal,
    });
    if (!res.ok) {
      // A rejected query shape lands here (400) — the failure mode that used to
      // be indistinguishable from an idle window.
      note({
        ok: false,
        reason: "http_error",
        status: res.status,
        detail: (await res.text().catch(() => "")).slice(0, 300),
      });
      return null;
    }
    const json = await res.json();
    const rawTotal = pickSignozQueryValue(json, "A");
    const errors = pickSignozQueryValue(json, "B") ?? 0;
    const p95Ns = pickSignozQueryValue(json, "C");
    if (rawTotal === undefined) {
      // 200 OK but no readable "A" column: the response envelope isn't one this
      // parser understands. Distinct from "no traffic" — this is a real defect,
      // not an idle window.
      note({
        ok: false,
        reason: "unparseable",
        detail: JSON.stringify(json).slice(0, 300),
      });
      return null;
    }
    if (rawTotal <= 0) {
      note({ ok: true, reason: "no_traffic" });
      return null; // no traffic in window → no verdict
    }
    note({ ok: true, reason: "ok", detail: `samples=${rawTotal}` });
    return {
      errorRate: errors / rawTotal,
      p95Ms: p95Ns !== undefined ? p95Ns / 1_000_000 : 0,
      samples: rawTotal,
    };
  } catch (error) {
    // Timeout, network, parse, or auth failure — signal simply absent.
    note({
      ok: false,
      reason: "network_error",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refreshes and caches a provider verdict. Concurrent callers share one request
 * so a cold burst cannot stampede the SigNoz query API.
 */
export function refreshSignozHealth(
  provider: Provider,
): Promise<SignozHealth | null> {
  const existing = inFlight.get(provider);
  if (existing) return existing;

  const task = fetchSignozHealth(provider)
    .catch(() => null)
    .then((value) => {
      signozCache.set(provider, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(provider);
    });
  inFlight.set(provider, task);
  return task;
}

// Return the cached SigNoz verdict for a provider, kicking off a background
// refresh if the cache is stale. NEVER awaits the refresh — the hot path reads
// whatever is cached (possibly null, possibly slightly stale) and moves on.
function signozSignal(provider: Provider): SignozHealth | null {
  if (!signozConfigured()) return null;
  const entry = signozCache.get(provider);
  const now = Date.now();
  const stale = !entry || now - entry.at >= REFRESH_MS;
  if (stale && !inFlight.has(provider)) {
    void refreshSignozHealth(provider);
  }
  return entry?.value ?? null;
}

// ── Combined verdict ────────────────────────────────────────────────────────

export type HealthVerdict = {
  degraded: boolean;
  reason: string;
  source: "local" | "signoz" | "forced" | "healthy";
  detail: Record<string, number | string>;
};

function forcedFor(provider: Provider): boolean {
  if (!FORCE_DEGRADED) return false;
  if (FORCE_DEGRADED === "1" || FORCE_DEGRADED.toLowerCase() === "true") {
    return true;
  }
  return FORCE_DEGRADED.toLowerCase() === provider;
}

// The health verdict for a provider, combining both signals. Degraded when
// EITHER the local window or the SigNoz window crosses a threshold — local
// catches a fast local burst, SigNoz catches a fleet-wide regression this pod
// hasn't personally hit yet. Fail-open: any doubt resolves to healthy.
export function getModelHealth(provider: Provider): HealthVerdict {
  if (DISABLED) {
    return { degraded: false, reason: "disabled", source: "healthy", detail: {} };
  }
  if (forcedFor(provider)) {
    return {
      degraded: true,
      reason: `forced via MODEL_HEALTH_FORCE_DEGRADED`,
      source: "forced",
      detail: { provider },
    };
  }

  const local = localSignal(provider);
  if (local.samples >= MIN_SAMPLES && local.rate >= ERROR_RATE_THRESHOLD) {
    return {
      degraded: true,
      reason: `local error rate ${(local.rate * 100).toFixed(0)}% over ${local.samples} calls`,
      source: "local",
      detail: { errorRate: local.rate, samples: local.samples },
    };
  }

  const sig = signozSignal(provider);
  if (sig && sig.samples >= MIN_SAMPLES) {
    if (sig.errorRate >= ERROR_RATE_THRESHOLD) {
      return {
        degraded: true,
        reason: `SigNoz error rate ${(sig.errorRate * 100).toFixed(0)}% over ${sig.samples} calls`,
        source: "signoz",
        detail: { errorRate: sig.errorRate, samples: sig.samples },
      };
    }
    if (sig.p95Ms >= P95_MS_THRESHOLD) {
      return {
        degraded: true,
        reason: `SigNoz p95 ${(sig.p95Ms / 1000).toFixed(1)}s over ${sig.samples} calls`,
        source: "signoz",
        detail: { p95Ms: sig.p95Ms, samples: sig.samples },
      };
    }
  }

  return { degraded: false, reason: "healthy", source: "healthy", detail: {} };
}

// Emit a span the moment a failover DECISION is taken, so the switch is visible
// in the same SigNoz trace waterfall as the turn it protected — click the trace,
// see "we ran on bedrock because fireworks was degraded". mastra.span.type =
// "model_failover" is the discriminator a dashboard/alert can count on. Best
// effort; no-op when SigNoz is off.
export function emitFailoverSpan(args: {
  from: Provider;
  to: Provider;
  verdict: HealthVerdict;
}): void {
  const tracer = getSignozTracer();
  if (!tracer) return;
  try {
    const span = tracer.startSpan("model_failover", { kind: SpanKind.INTERNAL });
    span.setAttribute("mastra.span.type", "model_failover");
    span.setAttribute("casper.self_instrumented", true);
    span.setAttribute("model.failover.from", args.from);
    span.setAttribute("model.failover.to", args.to);
    span.setAttribute("model.failover.reason", args.verdict.reason);
    span.setAttribute("model.failover.source", args.verdict.source);
    // A failover is an operational event, not an error of THIS span — but mark it
    // so it stands out in the trace list. ERROR status makes it trivially
    // filterable ("show me every time we failed over").
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  } catch {
    // Observability of the failover is best-effort; never break the request.
  }
}
