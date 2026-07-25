import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type BuilderSpec = {
  name?: string;
  signal?: string;
  filter?: { expression?: string };
};

function signalQueries(value: unknown): BuilderSpec[] {
  const found: BuilderSpec[] = [];
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.signal === "string") found.push(record as BuilderSpec);
    Object.values(record).forEach(visit);
  }
  visit(value);
  return found;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("versioned SigNoz assets", () => {
  it("scopes every dashboard signal query by service and environment", () => {
    const path = join(
      process.cwd(),
      "deploy/signoz/dashboards/agent-llm-observability.json",
    );
    const queries = signalQueries(readJson(path));
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      const expression = query.filter?.expression ?? "";
      expect(expression, `${query.signal}:${query.name}`).toContain(
        "service.name = 'casper-assistant'",
      );
      expect(expression, `${query.signal}:${query.name}`).toContain(
        "deployment.environment.name = $environment",
      );
    }
  });

  it("scopes every alert signal query by service and production environment", () => {
    const directory = join(process.cwd(), "deploy/signoz/alerts");
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      for (const query of signalQueries(readJson(join(directory, file)))) {
        const expression = query.filter?.expression ?? "";
        expect(expression, `${file}:${query.signal}:${query.name}`).toContain(
          "service.name = 'casper-assistant'",
        );
        expect(expression, `${file}:${query.signal}:${query.name}`).toContain(
          "deployment.environment.name = 'production'",
        );
      }
    }
  });

  it("keeps the health-watch panels and rules disjoint on mastra.health_watch.ok", () => {
    // The watch emits ONE span type for two opposite outcomes: a heartbeat on a
    // clean pass (ok = true) and a failure span (ok = false). Anything reading
    // `mastra.span.type = 'health_watch'` without also pinning `ok` therefore
    // conflates them — the failures panel would count healthy ticks as failures,
    // and the down alert would page on every successful run. That regression is
    // invisible in review (the filter still looks right) and only shows up as a
    // wrong number on a dashboard, so pin it here.
    const targets = [
      join(process.cwd(), "deploy/signoz/dashboards/agent-llm-observability.json"),
      join(process.cwd(), "deploy/signoz/alerts/health-watch-down.json"),
    ];

    let checked = 0;
    for (const path of targets) {
      for (const query of signalQueries(readJson(path))) {
        const expression = query.filter?.expression ?? "";
        if (!expression.includes("mastra.span.type = 'health_watch'")) continue;
        checked++;
        expect(
          /mastra\.health_watch\.ok = (true|false)/.test(expression),
          `${path}: a health_watch query must pin mastra.health_watch.ok — got: ${expression}`,
        ).toBe(true);
      }
    }
    // Guard the guard: if the panels are ever renamed away, this test must fail
    // loudly rather than pass vacuously over zero queries.
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it("alerts on the health-watch going absent, not only on it failing", () => {
    // Every other rule fires on telemetry the agent PRODUCES, so a watch that
    // stopped running makes them all go quiet — and quiet reads as healthy. The
    // absence rule is the only thing covering that, and it needs SigNoz's
    // `alertOnAbsent` (undocumented, verified against v0.134.0) to work at all:
    // without the flag the identical query returns zero alerts on zero data.
    const rule = readJson(
      join(process.cwd(), "deploy/signoz/alerts/health-watch-absent.json"),
    ) as {
      condition?: {
        alertOnAbsent?: boolean;
        absentFor?: number;
        compositeQuery?: unknown;
      };
    };

    expect(rule.condition?.alertOnAbsent).toBe(true);
    expect(rule.condition?.absentFor).toBeGreaterThan(0);

    // Bucket width is load-bearing, not cosmetic: absence is evaluated per
    // bucket, so a bucket narrower than the */15 cron's gap makes the rule fire
    // against a perfectly healthy watch. Measured on a live instance: 900 and
    // 1800 false-fire, 3600 does not.
    const queries = signalQueries(rule) as (BuilderSpec & {
      stepInterval?: number;
    })[];
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.stepInterval, "stepInterval must stay >= 3600").toBeGreaterThanOrEqual(3600);
      // Must match the span type WITHOUT pinning ok: absence of EITHER outcome
      // is the signal. Pinning ok=true here would keep firing while the watch
      // is alive-but-failing, which the down rule already covers.
      expect(query.filter?.expression).toContain(
        "mastra.span.type = 'health_watch'",
      );
      expect(query.filter?.expression).not.toContain("mastra.health_watch.ok");
    }
  });

  it("versions every notification channel the alert rules route to", () => {
    // SigNoz resolves `channels` by NAME and never creates the channel, so a
    // rule naming one that no versioned file defines imports fine and then has
    // nowhere to deliver — silently, since a rule that never fires and a rule
    // that fires into nothing look identical. That gap shipped once: the nine
    // rules all named `casper-default` while nothing under deploy/ created it
    // and the alerts README claimed no channel was set at all.
    const alertsDir = join(process.cwd(), "deploy/signoz/alerts");
    const channelsDir = join(process.cwd(), "deploy/signoz/channels");

    const defined = new Set(
      readdirSync(channelsDir)
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) => (readJson(join(channelsDir, name)) as { name?: string }).name,
        ),
    );
    expect(defined.size).toBeGreaterThan(0);

    const referenced = new Map<string, string>();
    for (const file of readdirSync(alertsDir).filter((name) =>
      name.endsWith(".json"),
    )) {
      const rule = readJson(join(alertsDir, file)) as {
        condition?: {
          thresholds?: { spec?: Array<{ channels?: string[] }> };
        };
      };
      const thresholds = rule.condition?.thresholds?.spec ?? [];
      // Every rule must route somewhere: `usePolicy: false` plus an empty
      // `channels` is a rule that evaluates and notifies nobody.
      expect(thresholds.length, file).toBeGreaterThan(0);
      for (const threshold of thresholds) {
        expect(threshold.channels?.length, file).toBeGreaterThan(0);
        for (const channel of threshold.channels ?? []) {
          referenced.set(channel, file);
        }
      }
    }

    for (const [channel, file] of referenced) {
      expect(
        defined.has(channel),
        `${file} routes to "${channel}", which no file in deploy/signoz/channels defines`,
      ).toBe(true);
    }
  });

  it("keeps the trace funnel ordered, scoped, and on an agent that actually emits its steps", () => {
    // SigNoz funnel steps match by exact `service_name` + `span_name`; the
    // per-step attribute filter is only a refinement (verified on v0.134 — see
    // deploy/signoz/funnels/README.md). Mastra names spans `<operation>
    // <entityName>`, so each step's span_name must open with the operation its
    // own mastra.span.type filter claims, or the step silently never matches
    // and the funnel reads as 100% drop-off.
    //
    // The entity matters just as much, and this is the part that shipped WRONG:
    // the funnel pointed at "Casper Assistant", the top-level supervisor. That
    // agent never emits `invoke_agent` or `model_inference` at all — Mastra
    // emits those only for a SUB-agent invoked as a tool, while the supervisor
    // turn (handleChatStream) produces `model_chunk Casper Assistant` instead.
    // So steps 1 and 3 matched nothing and the whole funnel read as zero, in
    // silence. Measured against the live instance on 2026-07-25: 0 traces in 24h
    // carried `invoke_agent Casper Assistant`, while `invoke_agent Meeting
    // Search Specialist` carried 5. Pin the supervisor OUT by name so this
    // cannot regress — a funnel that matches nothing looks identical to a
    // pipeline with no traffic.
    const funnel = readJson(
      join(process.cwd(), "deploy/signoz/funnels/agent-pipeline-funnel.json"),
    ) as {
      steps?: {
        step_order?: number;
        service_name?: string;
        span_name?: string;
        filters?: { items?: { key?: { key?: string }; value?: unknown }[] };
      }[];
    };
    const steps = funnel.steps ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(2);

    const operationBySpanType: Record<string, string> = {
      agent_run: "invoke_agent",
      tool_call: "execute_tool",
      model_inference: "model_inference",
    };

    steps.forEach((step, index) => {
      // Contiguous 1..N — SigNoz evaluates steps in temporal order and a gap
      // or duplicate order silently reshapes the funnel.
      expect(step.step_order, `step ${index}`).toBe(index + 1);
      expect(step.service_name, `step ${index}`).toBe("casper-assistant");

      const spanType = step.filters?.items?.find(
        (item) => item.key?.key === "mastra.span.type",
      )?.value;
      expect(spanType, `step ${index} must filter on mastra.span.type`).toBeDefined();
      const operation = operationBySpanType[String(spanType)];
      expect(operation, `step ${index}: unknown span type ${String(spanType)}`).toBeDefined();
      expect(
        step.span_name?.startsWith(`${operation} `),
        `step ${index}: span_name "${step.span_name}" does not match its own filter (${String(spanType)} → "${operation} …")`,
      ).toBe(true);
    });

    // Steps 1 and 3 are the agent itself. Both must name the SAME entity — a
    // funnel that starts on one agent and ends on another measures nothing
    // coherent — and that entity must be one that actually emits these spans.
    const entityOf = (name: string | undefined, operation: string) =>
      (name ?? "").slice(operation.length + 1);
    const first = entityOf(steps[0]!.span_name, "invoke_agent");
    const last = entityOf(steps.at(-1)!.span_name, "model_inference");
    expect(first).not.toBe("");
    expect(last, "steps 1 and 3 must follow the same agent").toBe(first);

    // The supervisor is the one entity that CANNOT be a funnel step (see above).
    // Also keep the self-observability agent out: it runs on cron, so a funnel
    // aimed at it reports the app watching itself, not user traffic.
    for (const forbidden of ["Casper Assistant", "SRE Health Automation"]) {
      expect(
        first,
        `"${forbidden}" cannot anchor the funnel — it emits no invoke_agent/model_inference span pair from real user traffic`,
      ).not.toBe(forbidden);
    }
  });
});
