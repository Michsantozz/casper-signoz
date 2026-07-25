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
});
