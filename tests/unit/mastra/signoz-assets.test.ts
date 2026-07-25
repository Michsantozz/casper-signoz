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
