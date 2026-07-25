import { MCPClient } from "@mastra/mcp";

/**
 * MCP client connecting the agent to its OWN SigNoz telemetry — the "SRE-copilot"
 * path: the agent reads back the traces/metrics/logs it emits, so it can debug
 * itself (token spend by model, failing tools, LLM errors, latency percentiles).
 *
 * Distinct from src/mastra/mcp.ts (Recall.ai): different external system, kept
 * in its own client per the "one client per external system" granularity.
 *
 * Unlike Recall data, SigNoz telemetry is workspace-wide rather than tenant
 * scoped. That makes authorization and least privilege mandatory: the raw MCP
 * toolset is never exported to an agent unchanged.
 *
 * Server: signoz/signoz-mcp-server (HTTP transport). Auth: `SIGNOZ-API-KEY` +
 * optional `X-SigNoz-URL` headers (a SigNoz service-account key + the instance
 * URL). Only registered when SIGNOZ_MCP_URL is set — absent → no tools, no-op.
 *
 * Tools are filtered before they reach an agent:
 * - interactive/operator surfaces receive read-only tools;
 * - the internal health automation additionally receives the two explicitly
 *   approved create operations (alerts and dashboards).
 *
 * The filtering is intentionally fail-closed: a newly-added MCP mutation is
 * classified as write and remains unavailable until it is explicitly allowed.
 */
const signozMcpUrl = process.env.SIGNOZ_MCP_URL;
const signozApiKey = process.env.SIGNOZ_MCP_API_KEY;
const signozInstanceUrl = process.env.SIGNOZ_INSTANCE_URL;

const signozMcp = new MCPClient({
  id: "signoz-mcp",
  timeout: 30000,
  servers: {
    ...(signozMcpUrl
      ? {
          signoz: {
            url: new URL(signozMcpUrl),
            requestInit: {
              headers: {
                ...(signozApiKey ? { "SIGNOZ-API-KEY": signozApiKey } : {}),
                ...(signozInstanceUrl
                  ? { "X-SigNoz-URL": signozInstanceUrl }
                  : {}),
              },
            },
          },
        }
      : {}),
  },
});

/** True when the SigNoz MCP server is configured (env present). */
export const signozMcpEnabled = Boolean(signozMcpUrl);

type SignozToolset = Awaited<ReturnType<typeof signozMcp.listTools>>;

const MUTATION_VERBS = new Set([
  "ack",
  "acknowledge",
  "apply",
  "create",
  "delete",
  "disable",
  "enable",
  "import",
  "mute",
  "patch",
  "remove",
  "resolve",
  "save",
  "set",
  "silence",
  "unmute",
  "update",
  "write",
]);

const READ_VERBS = new Set([
  "aggregate",
  "discover",
  "fetch",
  "find",
  "get",
  "history",
  "inspect",
  "list",
  "query",
  "read",
  "search",
]);

const AUTOMATION_WRITE_SUFFIXES = [
  "create_alert",
  "create_alert_rule",
  "create_dashboard",
] as const;

function normalizedToolName(name: string): string {
  return name.toLowerCase().replaceAll(/[.:\-/]+/g, "_");
}

/**
 * Classifies SigNoz tools by capability from their MCP name. Mutation verbs
 * always win. A tool without an explicitly recognized read verb is also treated
 * as a write, so a newly-added or renamed MCP capability fails closed.
 */
export function isSignozWriteTool(name: string): boolean {
  const parts = normalizedToolName(name).split("_");
  if (parts.some((part) => MUTATION_VERBS.has(part))) return true;
  return !parts.some((part) => READ_VERBS.has(part));
}

function isApprovedAutomationWrite(name: string): boolean {
  const normalized = normalizedToolName(name);
  return AUTOMATION_WRITE_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`),
  );
}

function filterTools(
  tools: SignozToolset,
  allowWrite: (name: string) => boolean,
): SignozToolset {
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name]) => !isSignozWriteTool(name) || allowWrite(name),
    ),
  ) as SignozToolset;
}

/** Read-only SigNoz tools for human-facing/operator agent surfaces. */
export async function listSignozReadTools(): Promise<SignozToolset> {
  return filterTools(await signozMcp.listTools(), () => false);
}

// ── Autonomous-write guard ──────────────────────────────────────────────────
//
// The health watch runs every 15 minutes with create-alert authority, and its
// only defense against creating the same rule twice used to be a sentence in the
// prompt ("list existing rules and DON'T duplicate one"). That predicate is
// semantic — "does an existing rule COVER this?" — evaluated by an LLM over rule
// names it generated itself on previous ticks. Two runs observing the same
// symptom can easily produce "High tool_call failure rate" and "Tool failures
// elevated — list_calendar_events" and neither recognizes the other.
//
// That would be survivable if the loop could clean up, but the capability filter
// (correctly) denies update/delete: the loop can only ADD. So every divergence is
// permanent and monotonic — 96 ticks a day, forever.
//
// Fix: keep the JUDGMENT in the agent ("is this worth alerting on?" genuinely
// needs it) and move UNIQUENESS into code. Every autonomously-created alert must
// carry a canonical name under a reserved prefix; the tool wrapper below derives
// the key, checks it against the rules that already exist, and turns a duplicate
// create into a no-op the agent is told about. No LLM judgment participates in
// the uniqueness decision.
export const AUTO_ALERT_PREFIX = "casper-auto/";

/** Names a rule as one this loop owns, so its own creations are recognizable. */
export function isAutoProvisionedName(name: string): boolean {
  return name.trim().toLowerCase().startsWith(AUTO_ALERT_PREFIX);
}

/**
 * Canonical identity for an auto-provisioned alert. Derived from the alert's
 * NAME only, normalized so cosmetic rewording collapses onto one key: lowercase,
 * punctuation dropped, whitespace collapsed. Deliberately not derived from the
 * threshold — a rule watching the same symptom at a different number is the same
 * rule, and re-creating it under a second name is precisely the accumulation
 * this prevents.
 */
export function canonicalAlertKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(new RegExp(`^${AUTO_ALERT_PREFIX}`), "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pull a probable alert/rule name out of an arbitrary MCP tool payload. */
function extractAlertName(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["alert", "alertName", "name", "rule_name", "ruleName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Some servers nest the rule under `rule`/`data`/`payload`.
  for (const key of ["rule", "data", "payload", "body"]) {
    const nested = extractAlertName(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

// Structural view of an MCP tool: the only field this guard touches is
// `execute`. Kept without an index signature so it stays assignable from
// Mastra's concrete Tool type.
type ToolLike = {
  execute?: (...args: never[]) => unknown;
};

/**
 * Wraps the approved create-alert tool with a deterministic idempotency guard.
 *
 * `listExistingNames` is injected so this stays pure/testable — it returns the
 * names of alert rules currently in SigNoz.
 */
export function withAlertIdempotency<T extends ToolLike>(
  tool: T,
  listExistingNames: () => Promise<string[]>,
): T {
  if (typeof tool.execute !== "function") return tool;
  const original = tool.execute.bind(tool) as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const wrapped = async (...callArgs: unknown[]) => {
    // Mastra passes { context, ... }; the raw args object is also supported.
    const first = callArgs[0] as Record<string, unknown> | undefined;
    const payload = (first?.context ?? first) as unknown;
    const name = extractAlertName(payload);

    // Unnamed create → refuse rather than let an unidentifiable rule through:
    // a rule with no canonical name can never be deduplicated on a later tick.
    if (!name) {
      return {
        created: false,
        reason:
          "REFUSED: an autonomously created alert must have a name so it can be deduplicated on later runs.",
      };
    }

    const key = canonicalAlertKey(name);
    const existing = await listExistingNames().catch(() => null);
    // Fail CLOSED: if the existing rules can't be listed we cannot prove this
    // isn't a duplicate, and the loop has no way to delete a mistake. Skipping a
    // tick's alert is recoverable; an undeletable duplicate is not.
    if (existing === null) {
      return {
        created: false,
        reason:
          "REFUSED: could not list existing alert rules, so duplicate-safety can't be verified. Skipping creation this cycle.",
      };
    }

    const clash = existing.find((candidate) => canonicalAlertKey(candidate) === key);
    if (clash) {
      return {
        created: false,
        deduplicated: true,
        existingAlert: clash,
        reason: `An alert with the canonical key "${key}" already exists ("${clash}"). Not creating a duplicate.`,
      };
    }

    // Stamp the reserved prefix so later ticks (and operators) can tell which
    // rules this loop owns.
    const canonicalName = isAutoProvisionedName(name)
      ? name
      : `${AUTO_ALERT_PREFIX}${key}`;
    const patched = { ...(payload as Record<string, unknown>) };
    for (const field of ["alert", "alertName", "name"]) {
      if (typeof patched[field] === "string") patched[field] = canonicalName;
    }
    if (!("alert" in patched) && !("alertName" in patched) && !("name" in patched)) {
      patched.alert = canonicalName;
    }

    const nextArgs = [...callArgs];
    nextArgs[0] = first?.context ? { ...first, context: patched } : patched;
    return original(...nextArgs);
  };

  return { ...tool, execute: wrapped } as T;
}

/** True when an MCP tool name is the approved create-alert operation. */
function isCreateAlertTool(name: string): boolean {
  const normalized = normalizedToolName(name);
  return (
    normalized === "create_alert" ||
    normalized === "create_alert_rule" ||
    normalized.endsWith("_create_alert") ||
    normalized.endsWith("_create_alert_rule")
  );
}

/** Best-effort read of existing alert-rule names via whichever list tool exists. */
async function listAlertRuleNames(tools: SignozToolset): Promise<string[]> {
  const entry = Object.entries(tools).find(([name]) => {
    const normalized = normalizedToolName(name);
    return (
      normalized.includes("alert") &&
      (normalized.includes("list") || normalized.includes("get_alerts"))
    );
  });
  if (!entry) throw new Error("no alert-listing tool available");

  const [, tool] = entry as [string, ToolLike];
  if (typeof tool.execute !== "function") {
    throw new Error("alert-listing tool is not executable");
  }
  const result = await (tool.execute as (...a: unknown[]) => Promise<unknown>)({
    context: {},
  });

  const names: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    const name = extractAlertName(record);
    if (name) names.push(name);
    Object.values(record).forEach(visit);
  };
  visit(result);
  return names;
}

/**
 * Least-privilege toolset for the autonomous health loop: all reads plus only
 * create-alert/create-dashboard. Update/delete/mute and future mutations remain
 * denied even if the MCP server later exposes them.
 *
 * The create-alert tool is additionally wrapped in a deterministic idempotency
 * guard (see withAlertIdempotency) — uniqueness is enforced in code, not by the
 * prompt, because this loop can create but never delete.
 */
export async function listSignozAutomationTools(): Promise<SignozToolset> {
  const tools = filterTools(
    await signozMcp.listTools(),
    isApprovedAutomationWrite,
  );

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      isCreateAlertTool(name)
        ? withAlertIdempotency(tool as ToolLike, () => listAlertRuleNames(tools))
        : tool,
    ]),
  ) as SignozToolset;
}
