import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// pnpm signoz:import is the ONE reproducible path from the versioned assets in
// deploy/signoz/ to a live instance — if it regresses, the fallback is the curl
// checklist it exists to replace. Its contracts are all observable over HTTP,
// so instead of exporting internals we run the real script (same tsx entry the
// pnpm alias uses) against an in-process mock SigNoz and assert on the requests:
//   - --dry-run never writes;
//   - the channel lands before the rules that reference it by name;
//   - idempotency by name/title updates in place instead of piling duplicates
//     (including the dashboard whose hand-created slug differs from the
//     versioned title's slug — the regression called out in the script header);
//   - a validation failure or missing env exits non-zero, so it can gate CI.

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = join(ROOT, "scripts", "signoz-import.ts");

// Every asset the script will read — sourced from disk so these tests track
// deploy/signoz/ instead of hardcoding today's file list.
function assetNames(dir: string, field: string): string[] {
  const full = join(ROOT, "deploy", "signoz", dir);
  return readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .map((f) => String(JSON.parse(readFileSync(join(full, f), "utf8"))[field]));
}
const CHANNEL_NAMES = assetNames("channels", "name");
const ALERT_NAMES = assetNames("alerts", "alert");
const DASHBOARD_TITLES = assetNames("dashboards", "name");

type Call = { method: string; url: string; body?: unknown };

type MockState = {
  channels?: { id: string; name: string }[];
  rules?: { id: string; alert: string }[];
  dashboards?: { id: string; name: string; spec?: { display?: { name?: string } } }[];
  ruleTestStatus?: number;
};

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startMockSignoz(state: MockState = {}) {
  const calls: Call[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
      });

      const route = `${req.method} ${req.url}`;
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (route === "GET /api/v1/version") return json(200, { version: "test" });
      if (route === "GET /api/v1/channels")
        return json(200, { data: state.channels ?? [] });
      if (route === "GET /api/v2/dashboards")
        return json(200, { data: { dashboards: state.dashboards ?? [] } });
      if (route === "GET /api/v2/rules") return json(200, { data: state.rules ?? [] });
      if (route === "POST /api/v2/rules/test")
        return json(state.ruleTestStatus ?? 200, {
          error: { message: "bad expression" },
        });
      // Any write — accept it; the assertions read `calls`, not the responses.
      return json(200, { data: {} });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { calls, url: `http://127.0.0.1:${port}` };
}

async function runImport(args: string[], baseUrl?: string) {
  const env = { ...process.env };
  delete env.SIGNOZ_INSTANCE_URL;
  delete env.SIGNOZ_MCP_API_KEY;
  if (baseUrl) {
    env.SIGNOZ_INSTANCE_URL = baseUrl;
    env.SIGNOZ_MCP_API_KEY = "test-service-account-key";
  }
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [SCRIPT, ...args], {
      cwd: ROOT,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const isWrite = (c: Call) =>
  (c.method === "PUT" || c.method === "POST") && c.url !== "/api/v2/rules/test";

describe("scripts/signoz-import.ts against a mock SigNoz API", () => {
  it("--dry-run validates every rule server-side and writes nothing", async () => {
    const { calls, url } = await startMockSignoz();
    const result = await runImport(["--dry-run"], url);

    expect(result.code, result.stderr).toBe(0);
    expect(calls.filter(isWrite)).toEqual([]);
    // One POST /api/v2/rules/test per versioned alert — dry-run must not skip
    // validation, that is the whole point of the flag.
    expect(
      calls.filter((c) => c.url === "/api/v2/rules/test").length,
    ).toBe(ALERT_NAMES.length);
    expect(result.stdout).toContain("DRY RUN");
  }, 30_000);

  it("creates every asset on an empty instance, channel strictly first", async () => {
    const { calls, url } = await startMockSignoz();
    const result = await runImport([], url);

    expect(result.code, result.stderr).toBe(0);
    const writes = calls.filter(isWrite);
    // Empty instance → everything is a create; a PUT here means the by-name
    // lookup matched something that does not exist.
    expect(writes.every((c) => c.method === "POST"), JSON.stringify(writes)).toBe(true);
    expect(
      writes.filter((c) => c.url === "/api/v1/channels").length,
    ).toBe(CHANNEL_NAMES.length);
    expect(
      writes.filter((c) => c.url === "/api/v2/dashboards").length,
    ).toBe(DASHBOARD_TITLES.length);
    expect(writes.filter((c) => c.url === "/api/v2/rules").length).toBe(
      ALERT_NAMES.length,
    );

    // Rules reference the channel BY NAME and SigNoz never creates it for
    // them — so every channel write must precede the first rule write.
    const lastChannel = writes.reduce(
      (last, c, i) => (c.url === "/api/v1/channels" ? i : last),
      -1,
    );
    const firstRule = writes.findIndex((c) => c.url === "/api/v2/rules");
    expect(lastChannel).toBeGreaterThanOrEqual(0);
    expect(lastChannel).toBeLessThan(firstRule);

    // The dashboard payload carries an RFC-1123 slug, not the human title.
    const dashboard = writes.find((c) => c.url === "/api/v2/dashboards");
    const payload = dashboard?.body as { name?: string };
    expect(payload.name).toMatch(/^[a-z0-9-]{1,63}$/);
  }, 30_000);

  it("updates in place by name — including a dashboard whose slug disagrees with its title", async () => {
    const { calls, url } = await startMockSignoz({
      channels: CHANNEL_NAMES.map((name, i) => ({ id: `ch-${i}`, name })),
      rules: ALERT_NAMES.map((alert, i) => ({ id: `rule-${i}`, alert })),
      // The hand-created dashboard: its stored slug is NOT what slugifying the
      // versioned title yields, but the human title matches. Matching on slug
      // alone would create a second dashboard on every import.
      dashboards: DASHBOARD_TITLES.map((title, i) => ({
        id: `dash-${i}`,
        name: `hand-typed-slug-${i}`,
        spec: { display: { name: title } },
      })),
    });
    const result = await runImport([], url);

    expect(result.code, result.stderr).toBe(0);
    const writes = calls.filter(isWrite);
    // Everything already exists → converge, never duplicate.
    expect(writes.every((c) => c.method === "PUT"), JSON.stringify(writes)).toBe(true);
    expect(writes.map((c) => c.url)).toContain("/api/v2/dashboards/dash-0");
    for (const [i] of ALERT_NAMES.entries()) {
      expect(writes.map((c) => c.url)).toContain(`/api/v2/rules/rule-${i}`);
    }
  }, 30_000);

  it("exits non-zero when a rule fails server-side validation", async () => {
    const { url } = await startMockSignoz({ ruleTestStatus: 400 });
    const result = await runImport(["--dry-run"], url);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("INVALID");
  }, 30_000);

  it("exits non-zero with setup instructions when the env is missing", async () => {
    const result = await runImport([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("SIGNOZ_INSTANCE_URL");
  }, 30_000);
});
