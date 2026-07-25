/**
 * Pushes every versioned SigNoz asset in `deploy/signoz/` into a running SigNoz
 * instance: the notification channel, the dashboard, and the alert rules.
 *
 * WHY THIS EXISTS: the assets were already versioned as code, but the only way
 * to APPLY them was a README telling the reader to run one `curl` per file, in
 * the right order, with the right endpoint per asset type. That is not a
 * reproducible deploy — it is a checklist, and the first person to skip a step
 * gets a dashboard whose alerts route to a channel that does not exist. The
 * ordering is real: rules reference the channel BY NAME (`casper-default`) and
 * SigNoz resolves that reference at fire time without creating it, so the
 * channel has to land first.
 *
 * Idempotent by name. Every asset type is looked up by its name first: absent →
 * created, present → updated in place. Re-running is a no-op-shaped convergence,
 * not a pile of duplicates — which matters because SigNoz will happily hold two
 * rules with the same name and no way to tell which one paged you.
 *
 *   SIGNOZ_INSTANCE_URL=http://localhost:8090 \
 *   SIGNOZ_MCP_API_KEY=<service-account-key> \
 *   pnpm signoz:import
 *
 * Flags:
 *   --dry-run   validate everything server-side (POST /api/v2/rules/test for
 *               rules) and report what WOULD change, without writing.
 *   --only=<a>  restrict to one asset class: channels | dashboards | alerts.
 *
 * Exits non-zero if any asset fails, so it can gate a demo or a CI step.
 *
 * Not covered: trace funnels. Their API is a two-call create+attach dance whose
 * steps are matched by exact span_name, so importing one blind would silently
 * produce a funnel that never matches. See deploy/signoz/funnels/README.md.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "deploy", "signoz");

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length);

type AssetClass = "channels" | "dashboards" | "alerts";

function wants(kind: AssetClass): boolean {
  return !ONLY || ONLY === kind;
}

// ── Output ──────────────────────────────────────────────────────────────────

const ok = (m: string) => console.log(`  ✅ ${m}`);
const skip = (m: string) => console.log(`  ⏭️  ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const bad = (m: string) => console.error(`  ❌ ${m}`);

let failures = 0;

function fail(message: string): never {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const BASE = process.env.SIGNOZ_INSTANCE_URL?.replace(/\/+$/, "");
const KEY = process.env.SIGNOZ_MCP_API_KEY;

async function api(
  method: string,
  routePath: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${BASE}${routePath}`, {
    method,
    headers: {
      "SIGNOZ-API-KEY": KEY!,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // A SigNoz route that doesn't exist serves the SPA's index.html, so a
    // non-JSON body means "wrong endpoint", not "malformed response".
  }
  return { status: res.status, json, text };
}

/** Pull the server's error message out of whichever envelope it used. */
function errorOf(r: { json: unknown; text: string }): string {
  const j = r.json as
    | { error?: { message?: string; errors?: { message?: string }[] } }
    | undefined;
  const detail = j?.error?.errors?.map((e) => e.message).filter(Boolean);
  return (
    [j?.error?.message, ...(detail ?? [])].filter(Boolean).join(" — ") ||
    r.text.slice(0, 300)
  );
}

/** Key-order-insensitive equality, for "did this asset actually change". */
function deepEqual(a: unknown, b: unknown): boolean {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, val]) => [k, sort(val)]),
          )
        : v;
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}

async function readJsonDir(dir: string): Promise<{ file: string; body: Record<string, unknown> }[]> {
  const full = path.join(ROOT, dir);
  const files = (await readdir(full)).filter((f) => f.endsWith(".json"));
  files.sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      body: JSON.parse(await readFile(path.join(full, file), "utf8")) as Record<
        string,
        unknown
      >,
    })),
  );
}

// ── Preflight ───────────────────────────────────────────────────────────────

async function preflight(): Promise<void> {
  const version = await api("GET", "/api/v1/version");
  if (version.status !== 200 || !version.json) {
    fail(
      `Cannot reach SigNoz at ${BASE} (HTTP ${version.status}). Is the instance up, and is SIGNOZ_INSTANCE_URL the UI/API port (not the OTLP 4318 port)?`,
    );
  }
  const v = version.json as { version?: string; ee?: string };
  console.log(`SigNoz ${v.version ?? "?"} at ${BASE}\n`);

  // Auth check that costs nothing: an unauthenticated/insufficient key fails
  // here rather than halfway through a partial import.
  const probe = await api("GET", "/api/v2/rules");
  if (probe.status === 401 || probe.status === 403) {
    fail(
      `SIGNOZ_MCP_API_KEY rejected (HTTP ${probe.status}). It must be a SERVICE ACCOUNT key with editor role (Settings → Service Accounts), not a personal login token.`,
    );
  }
}

// ── Channels ────────────────────────────────────────────────────────────────
//
// First, always: the rules name this channel and SigNoz will not create it for
// them.
async function importChannels(): Promise<void> {
  console.log("Notification channels");
  const existing = await api("GET", "/api/v1/channels");
  const byName = new Map<string, { id: string; data?: string }>();
  for (const c of ((existing.json as { data?: unknown[] })?.data ?? []) as {
    id?: string;
    name?: string;
    data?: string;
  }[]) {
    if (c.name && c.id) byName.set(c.name, { id: c.id, data: c.data });
  }

  for (const { file, body } of await readJsonDir("channels")) {
    const name = String(body.name ?? "");
    const found = byName.get(name);

    // Channel UPDATES need an admin key while everything else works with the
    // editor service account — so before touching it, check whether the live
    // channel already IS the versioned one (the list's `data` field is the
    // channel body serialized). Unchanged → converged, no write, no admin.
    if (found?.data) {
      try {
        if (deepEqual(JSON.parse(found.data), body)) {
          skip(`${file} → channel "${name}" unchanged`);
          continue;
        }
      } catch {
        // Unparseable data → treat as changed and fall through to the PUT.
      }
    }

    if (DRY_RUN) {
      skip(`${file} → would ${found ? "update" : "create"} channel "${name}"`);
      continue;
    }
    const res = found
      ? await api("PUT", `/api/v1/channels/${found.id}`, body)
      : await api("POST", "/api/v1/channels", body);
    if (res.status >= 200 && res.status < 300) {
      ok(`${file} → channel "${name}" ${found ? "updated" : "created"}`);
    } else {
      failures++;
      const hint =
        res.status === 403
          ? " (channel updates need an ADMIN service-account key; the editor role only creates)"
          : "";
      bad(`${file} → HTTP ${res.status}: ${errorOf(res)}${hint}`);
    }
  }
}

// ── Dashboards ──────────────────────────────────────────────────────────────

/** RFC-1123 slug the v2 dashboards API accepts as a name. */
function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

async function importDashboards(): Promise<void> {
  console.log("\nDashboards");
  const existing = await api("GET", "/api/v2/dashboards");

  // Identity is matched on the SLUG *and* on the human title, because the two
  // can legitimately disagree. The API stores an RFC-1123 `name`, and a
  // dashboard first created by hand carries whatever slug the operator typed
  // (`casper-agent-llm-observability`) while slugifying the versioned title
  // yields a different one (`casperagent-agent-llm-observability`). Matching on
  // the slug alone would then CREATE a second dashboard on every import instead
  // of updating the one already on screen — the exact duplicate-pile this
  // script exists to prevent. Title is the stable identity; the slug is a
  // secondary key.
  type Existing = { id: string; storedSlug?: string };
  const bySlug = new Map<string, Existing>();
  const byTitle = new Map<string, Existing>();
  for (const d of ((existing.json as { data?: { dashboards?: unknown[] } })?.data
    ?.dashboards ?? []) as {
    id?: string;
    name?: string;
    spec?: { display?: { name?: string } };
  }[]) {
    if (!d.id) continue;
    const entry: Existing = { id: d.id, storedSlug: d.name };
    if (d.name) bySlug.set(d.name, entry);
    const title = d.spec?.display?.name;
    if (title) byTitle.set(title, entry);
  }

  for (const { file, body } of await readJsonDir("dashboards")) {
    const spec = body.spec as
      | { display?: { name?: string }; panels?: Record<string, unknown> }
      | undefined;
    const title = spec?.display?.name ?? String(body.name ?? file);
    const slug = slugify(String(body.name ?? title));
    const panelCount = Object.keys(spec?.panels ?? {}).length;
    const found = byTitle.get(title) ?? bySlug.get(slug);
    const id = found?.id;
    // The API treats `name` (the slug) as IMMUTABLE after creation — updating
    // the title-matched dashboard with the versioned title's slug is a 400. On
    // update, keep whatever slug the live dashboard already carries; the slug
    // is an address, the title is the identity.
    const name = found?.storedSlug ?? slug;

    if (DRY_RUN) {
      skip(
        `${file} → would ${id ? "update" : "create"} "${name}" (${panelCount} panels)`,
      );
      continue;
    }

    const payload = {
      schemaVersion: body.schemaVersion ?? "v6",
      name,
      // The v2 API rejects plain-string tags ("try sending 'tagtypes.
      // PostableTag'") and serializes them back as {key, value} pairs — accept
      // the human-friendly string form in the versioned JSON and convert here.
      tags: ((body.tags as unknown[] | undefined) ?? []).map((tag) =>
        typeof tag === "string" ? { key: tag, value: "true" } : tag,
      ),
      spec: body.spec,
    };
    const res = id
      ? await api("PUT", `/api/v2/dashboards/${id}`, payload)
      : await api("POST", "/api/v2/dashboards", payload);

    if (res.status >= 200 && res.status < 300) {
      ok(
        `${file} → "${name}" ${id ? "updated" : "created"} (${panelCount} panels)`,
      );
      // The v2 (Perses) renderer sits behind an experimental, default-off flag
      // on current builds. Without it the API holds every panel and the UI
      // still shows an empty "Welcome to your new dashboard" — the most
      // expensive failure mode here, because nothing reports an error.
      if (payload.schemaVersion === "v6") {
        warn(
          `"${name}" uses schemaVersion v6 (Perses). If the UI renders it EMPTY, the v2 renderer flag is off — set SIGNOZ_FLAGGER_CONFIG_BOOLEAN_USE__DASHBOARD__V2=true on the signoz service and recreate it.`,
        );
      }
    } else {
      failures++;
      bad(`${file} → HTTP ${res.status}: ${errorOf(res)}`);
    }
  }
}

// ── Alert rules ─────────────────────────────────────────────────────────────

async function importAlerts(): Promise<void> {
  console.log("\nAlert rules");
  const existing = await api("GET", "/api/v2/rules");
  const byName = new Map<string, string>();
  for (const r of ((existing.json as { data?: unknown[] })?.data ?? []) as {
    id?: string;
    alert?: string;
  }[]) {
    if (r.alert && r.id) byName.set(r.alert, r.id);
  }

  for (const { file, body } of await readJsonDir("alerts")) {
    const name = String(body.alert ?? file);
    const id = byName.get(name);

    if (DRY_RUN) {
      // Server-side validation of the real payload — catches a bad query
      // expression or a missing required field before anything is written.
      const res = await api("POST", "/api/v2/rules/test", body);
      if (res.status >= 200 && res.status < 300) {
        skip(`${file} → valid; would ${id ? "update" : "create"} "${name}"`);
      } else {
        failures++;
        bad(`${file} → INVALID (HTTP ${res.status}): ${errorOf(res)}`);
      }
      continue;
    }

    const res = id
      ? await api("PUT", `/api/v2/rules/${id}`, body)
      : await api("POST", "/api/v2/rules", body);
    if (res.status >= 200 && res.status < 300) {
      ok(`${file} → "${name}" ${id ? "updated" : "created"}`);
    } else {
      failures++;
      bad(`${file} → HTTP ${res.status}: ${errorOf(res)}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!BASE || !KEY) {
    fail(
      "Set SIGNOZ_INSTANCE_URL and SIGNOZ_MCP_API_KEY.\n\n" +
        "  SIGNOZ_INSTANCE_URL=http://localhost:8090 \\\n" +
        "  SIGNOZ_MCP_API_KEY=<service-account-key> \\\n" +
        "  pnpm signoz:import\n\n" +
        "The key is a SigNoz SERVICE ACCOUNT key (Settings → Service Accounts → editor role).",
    );
  }

  console.log(DRY_RUN ? "SigNoz import — DRY RUN (no writes)\n" : "SigNoz import\n");
  await preflight();

  if (wants("channels")) await importChannels();
  if (wants("dashboards")) await importDashboards();
  if (wants("alerts")) await importAlerts();

  if (failures > 0) {
    fail(`${failures} asset(s) failed. Nothing else was rolled back.`);
  }

  console.log(
    DRY_RUN
      ? "\n✅ Everything validates. Re-run without --dry-run to apply."
      : "\n✅ All SigNoz assets applied.\n\n" +
          "Next: open the dashboard and set the Environment box to the value the app stamps\n" +
          "(DEPLOYMENT_ENVIRONMENT ?? VERCEL_ENV ?? NODE_ENV) — 'development' for a pnpm dev run.\n" +
          "A dashboard left on 'production' against a dev app renders every panel at zero.",
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
