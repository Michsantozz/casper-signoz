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
});
