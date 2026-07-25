import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const getSignozTracer = vi.fn();

vi.mock("@/mastra/llm-telemetry", () => ({
  getSignozTracer: () => getSignozTracer(),
}));

const HEALTH_ENV_KEYS = [
  "MODEL_HEALTH_WINDOW_MS",
  "MODEL_HEALTH_MIN_SAMPLES",
  "MODEL_HEALTH_ERROR_RATE_THRESHOLD",
  "MODEL_HEALTH_P95_MS_THRESHOLD",
  "MODEL_HEALTH_REFRESH_MS",
  "MODEL_HEALTH_SIGNOZ_LOOKBACK_MS",
  "MODEL_HEALTH_DISABLED",
  "MODEL_HEALTH_FORCE_DEGRADED",
  "MODEL_HEALTH_FIREWORKS_SPAN_PROVIDER",
  "MODEL_HEALTH_BEDROCK_SPAN_PROVIDER",
  "SIGNOZ_INSTANCE_URL",
  "SIGNOZ_MCP_API_KEY",
] as const;

async function load(overrides: Record<string, string> = {}) {
  vi.resetModules();
  for (const key of HEALTH_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  return import("@/mastra/model-health");
}

function signozResponse(args: {
  total: number | string;
  errors: number | string;
  p95Ns: number | string;
}) {
  const row = (queryName: string, value: number | string) => ({
    queryName,
    series: [{ values: [{ timestamp: 123, value }] }],
  });
  return new Response(
    JSON.stringify({
      data: {
        result: [
          row("A", args.total),
          row("B", args.errors),
          row("C", args.p95Ns),
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SigNoz health query/parser", () => {
  it("scopes every query to service, environment, provider, and own spans", async () => {
    const { buildSignozHealthQuery } = await load({
      MODEL_HEALTH_SIGNOZ_LOOKBACK_MS: "60000",
      DEPLOYMENT_ENVIRONMENT: "staging",
    });
    const body = buildSignozHealthQuery("bedrock", 100_000);
    expect(body.start).toBe(40_000);

    for (const query of body.compositeQuery.queries) {
      const expression = query.spec.filter.expression;
      expect(expression).toContain("service.name = 'casper-assistant'");
      expect(expression).toContain(
        "deployment.environment.name = 'staging'",
      );
      expect(expression).toContain("gen_ai.provider.name = 'amazon-bedrock'");
      expect(expression).toContain("casper.self_instrumented = true");
      expect(expression).toContain("mastra.span.type = 'model_generation'");
    }
  });

  it("speaks the same v2alpha1 builder dialect as the versioned dashboards/alerts", async () => {
    // The old v4 `compositeQuery.builderQueries` shape was never executed
    // against a live instance, while the v2alpha1 assets demonstrably import
    // and render. Sharing one dialect also keeps the failover verdict and the
    // panels an operator reads from drifting apart.
    const { buildSignozHealthQuery } = await load();
    const body = buildSignozHealthQuery("fireworks", 1_000_000);

    expect(body.compositeQuery.queryType).toBe("builder");
    expect(body.compositeQuery).not.toHaveProperty("builderQueries");
    expect(body.compositeQuery.queries.map((q) => q.spec.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
    for (const query of body.compositeQuery.queries) {
      expect(query.type).toBe("builder_query");
      expect(query.spec.signal).toBe("traces");
      // aggregations[] with an expression string — not aggregateOperator.
      expect(query.spec.aggregations).toHaveLength(1);
      expect(query).not.toHaveProperty("aggregateOperator");
    }
    // B narrows to error spans; C is the p95 of span duration.
    expect(body.compositeQuery.queries[1]!.spec.filter.expression).toContain(
      "error.type EXISTS",
    );
    expect(body.compositeQuery.queries[2]!.spec.aggregations[0]!.expression).toBe(
      "p95(duration_nano)",
    );
  });

  it("parses object points, tuple points, and table rows", async () => {
    const { pickSignozQueryValue } = await load();
    const payload = {
      data: {
        result: [
          { queryName: "A", series: [{ values: [{ value: "12" }] }] },
          { query_name: "B", series: [{ values: [[123, 3]] }] },
          { queryName: "C", table: { rows: [{ data: { C: "45000000" } }] } },
        ],
      },
    };

    expect(pickSignozQueryValue(payload, "A")).toBe(12);
    expect(pickSignozQueryValue(payload, "B")).toBe(3);
    expect(pickSignozQueryValue(payload, "C")).toBe(45_000_000);
  });

  it("parses the COLLAPSED table/scalar envelope (no per-entry queryName)", async () => {
    // THE REGRESSION THIS GUARDS: for a table/scalar request the queries do NOT
    // come back as one tagged entry each — they collapse into a SINGLE entry
    // whose row carries A/B/C as COLUMNS, with no `queryName` anywhere. The old
    // parser did `result.find(r => r.queryName === name)` first and bailed on a
    // miss, which made its own table-row fallback unreachable: every lookup
    // returned undefined, total fell to 0, and fetchSignozHealth reported "no
    // traffic" forever. The SigNoz signal was permanently absent and
    // indistinguishable from an idle window.
    const { pickSignozQueryValue } = await load();
    const collapsed = {
      data: {
        result: [
          {
            table: {
              columns: [{ name: "A" }, { name: "B" }, { name: "C" }],
              rows: [{ data: { A: 40, B: 10, C: 2_500_000_000 } }],
            },
          },
        ],
      },
    };

    expect(pickSignozQueryValue(collapsed, "A")).toBe(40);
    expect(pickSignozQueryValue(collapsed, "B")).toBe(10);
    expect(pickSignozQueryValue(collapsed, "C")).toBe(2_500_000_000);
  });

  it("yields a real verdict from a collapsed-envelope response end to end", async () => {
    // The parse fix must reach the VERDICT, not just the parser: this is the
    // path that previously degraded to `null` (no verdict) on every poll.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              result: [
                { rows: [{ data: { A: 20, B: 15, C: 1_000_000_000 } }] },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { refreshSignozHealth, getModelHealth, lastSignozProbe } = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
      MODEL_HEALTH_MIN_SAMPLES: "4",
      MODEL_HEALTH_ERROR_RATE_THRESHOLD: "0.5",
    });

    await refreshSignozHealth("fireworks");
    expect(lastSignozProbe("fireworks")).toMatchObject({ reason: "ok" });
    expect(getModelHealth("fireworks")).toMatchObject({
      degraded: true,
      source: "signoz",
      detail: { errorRate: 0.75, samples: 20 },
    });
  });

  it("distinguishes a rejected query shape from an idle window", async () => {
    // Both used to surface as a silent null, which is what hid the broken
    // parser. A 400 (shape rejected) is a DEFECT; "no traffic" is expected.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("unsupported field", { status: 400 })),
    );
    const rejected = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
    });
    expect(await rejected.refreshSignozHealth("fireworks")).toBeNull();
    expect(rejected.lastSignozProbe("fireworks")).toMatchObject({
      ok: false,
      reason: "http_error",
      status: 400,
    });

    // 200 OK with an envelope carrying no readable "A" → unparseable, not idle.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { result: [{ nonsense: 1 }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const unreadable = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
    });
    expect(await unreadable.refreshSignozHealth("bedrock")).toBeNull();
    expect(unreadable.lastSignozProbe("bedrock")).toMatchObject({
      ok: false,
      reason: "unparseable",
    });

    // A genuinely empty window is reported as ok:true / no_traffic.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: { result: [{ rows: [{ data: { A: 0 } }] }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const idle = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
    });
    expect(await idle.refreshSignozHealth("fireworks")).toBeNull();
    expect(idle.lastSignozProbe("fireworks")).toMatchObject({
      ok: true,
      reason: "no_traffic",
    });
  });

  it("fails open on malformed or non-numeric responses", async () => {
    const { pickSignozQueryValue } = await load();
    expect(pickSignozQueryValue(null, "A")).toBeUndefined();
    expect(
      pickSignozQueryValue(
        {
          data: {
            result: [
              { queryName: "A", series: [{ values: [{ value: "nope" }] }] },
            ],
          },
        },
        "A",
      ),
    ).toBeUndefined();
  });
});

describe("model health thresholds", () => {
  it("does not trip before the minimum sample count", async () => {
    const { noteLlmOutcome, getModelHealth } = await load({
      MODEL_HEALTH_MIN_SAMPLES: "4",
      MODEL_HEALTH_ERROR_RATE_THRESHOLD: "0.5",
    });
    noteLlmOutcome("openai.chat", false);
    noteLlmOutcome("openai.chat", false);

    expect(getModelHealth("fireworks")).toMatchObject({
      degraded: false,
      source: "healthy",
    });
  });

  it("trips at the configured local error-rate threshold", async () => {
    const { noteLlmOutcome, getModelHealth } = await load({
      MODEL_HEALTH_MIN_SAMPLES: "4",
      MODEL_HEALTH_ERROR_RATE_THRESHOLD: "0.5",
    });
    for (const ok of [true, false, false, true]) {
      noteLlmOutcome("openai.chat", ok);
    }

    expect(getModelHealth("fireworks")).toMatchObject({
      degraded: true,
      source: "local",
      detail: { errorRate: 0.5, samples: 4 },
    });
  });

  it("prunes samples outside the rolling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const { noteLlmOutcome, getModelHealth } = await load({
      MODEL_HEALTH_WINDOW_MS: "1000",
      MODEL_HEALTH_MIN_SAMPLES: "2",
      MODEL_HEALTH_ERROR_RATE_THRESHOLD: "0.5",
    });
    noteLlmOutcome("amazon-bedrock", false);
    noteLlmOutcome("amazon-bedrock", false);
    expect(getModelHealth("bedrock").degraded).toBe(true);

    vi.setSystemTime(new Date(1001));
    expect(getModelHealth("bedrock")).toMatchObject({
      degraded: false,
      source: "healthy",
    });
  });

  it("honors forced degradation and the kill switch", async () => {
    const forced = await load({
      MODEL_HEALTH_FORCE_DEGRADED: "bedrock",
    });
    expect(forced.getModelHealth("bedrock").source).toBe("forced");
    expect(forced.getModelHealth("fireworks").degraded).toBe(false);

    const disabled = await load({
      MODEL_HEALTH_DISABLED: "1",
      MODEL_HEALTH_FORCE_DEGRADED: "true",
    });
    expect(disabled.getModelHealth("bedrock")).toMatchObject({
      degraded: false,
      reason: "disabled",
    });
  });
});

describe("SigNoz cache, thresholds, and timeout", () => {
  it("deduplicates concurrent refreshes, caches the result, and trips on error rate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      signozResponse({ total: 8, errors: 5, p95Ns: 10_000_000_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { refreshSignozHealth, getModelHealth } = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
      MODEL_HEALTH_MIN_SAMPLES: "4",
      MODEL_HEALTH_ERROR_RATE_THRESHOLD: "0.5",
      MODEL_HEALTH_REFRESH_MS: "60000",
    });

    const [first, second] = await Promise.all([
      refreshSignozHealth("fireworks"),
      refreshSignozHealth("fireworks"),
    ]);
    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getModelHealth("fireworks")).toMatchObject({
      degraded: true,
      source: "signoz",
      detail: { errorRate: 0.625, samples: 8 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("trips on cached SigNoz p95 when error rate is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          signozResponse({ total: 10, errors: 0, p95Ns: 31_000_000_000 }),
        ),
    );
    const { refreshSignozHealth, getModelHealth } = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
      MODEL_HEALTH_MIN_SAMPLES: "4",
      MODEL_HEALTH_P95_MS_THRESHOLD: "30000",
    });
    await refreshSignozHealth("bedrock");

    expect(getModelHealth("bedrock")).toMatchObject({
      degraded: true,
      source: "signoz",
      detail: { p95Ms: 31_000, samples: 10 },
    });
  });

  it("aborts the SigNoz request at 5s and fails open", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) throw new Error("expected fetch AbortSignal");
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }),
    );
    const { refreshSignozHealth, getModelHealth } = await load({
      SIGNOZ_INSTANCE_URL: "https://signoz.example",
      SIGNOZ_MCP_API_KEY: "key",
    });

    const pending = refreshSignozHealth("fireworks");
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toBeNull();
    expect(receivedSignal?.aborted).toBe(true);
    expect(getModelHealth("fireworks").degraded).toBe(false);
  });
});
