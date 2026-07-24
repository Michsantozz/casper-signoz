import "server-only";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";
import { createNotificationsForUsers } from "@/server/notifications";

/**
 * Autonomous agent-health watch — the self-observing loop, no human in it.
 *
 * On a schedule (see agent-health-watch.workflow.ts) this drives the sreAgent
 * with a "watch yourself" prompt. The agent queries CasperAgent's OWN SigNoz
 * telemetry (error rate, failing tools, latency/cost), decides whether anything
 * warrants an alert, and — being told to act autonomously — provisions a SigNoz
 * alert rule for it via the MCP (idempotent: it checks for an existing rule
 * first). It returns a short operator-facing summary, which we surface as an
 * in-app notification so the loop is visible, not silent.
 *
 * This is deliberately agent-driven rather than a hand-coded threshold check:
 * the point is an agent that observes and repairs its own instrumentation
 * ("autonomous infrastructure repair"), not another cron with an if-statement.
 *
 * Safe no-op when the SigNoz MCP isn't wired (SIGNOZ_MCP_URL unset): the agent
 * has no telemetry tools, says so, and we skip notifying.
 */

const WATCH_PROMPT = `AUTONOMOUS HEALTH CHECK. You are running on a schedule, with no human in the loop, to watch CasperAgent's own health from its SigNoz telemetry.

Do this:
1. Look at the last 1 hour of telemetry: LLM error rate, the most-failing tool (mastra.span.type = 'tool_call' with error.type), p95 latency of model_generation spans, and total LLM cost.
2. Decide if anything is genuinely wrong — a tool failing repeatedly, an error rate that stands out, latency or cost clearly elevated. Use judgment; a couple of stray errors is not an incident.
3. If something warrants it, PROVISION a SigNoz alert for it (you are authorized to act autonomously): first list existing alert rules and DON'T duplicate one; only create if none covers it. Base the threshold on what you actually observed.
4. Reply with a SHORT operator summary (2-4 sentences): the health snapshot, and whether you created an alert (name it) or found nothing actionable. This summary goes straight to an operator notification — write it for a human skimming a bell icon.

If the telemetry backend isn't available (no tools), say exactly that in one sentence.`;

export type AgentHealthWatchResult = {
  ran: boolean;
  summary: string;
  notified: number;
};

/**
 * Runs one health-watch pass. `notify` (default true) controls whether the
 * summary is fanned out as a notification — the manual demo trigger can turn it
 * off to just see the summary.
 */
export async function runAgentHealthWatch(opts?: {
  notify?: boolean;
}): Promise<AgentHealthWatchResult> {
  const notify = opts?.notify ?? true;

  // Lazy import to avoid a static server → mastra → server import cycle
  // (mastra/index pulls in server modules). Same pattern as enrich.ts.
  const { mastra } = await import("@/mastra");
  const agent = mastra.getAgentById("sreAgent");
  if (!agent) {
    return { ran: false, summary: "sreAgent not registered", notified: 0 };
  }

  const res = await agent.generate(WATCH_PROMPT);
  const summary = (res?.text ?? "").trim() || "Health check produced no output.";

  // Force-flush the telemetry this pass emitted (LLM + the SRE-copilot's own
  // tool_call spans). A cron tick can be short-lived; without this, the batch
  // processors might not export before the run settles. No-op when SigNoz is off.
  try {
    const { flushLlmTelemetry } = await import("@/mastra/llm-telemetry");
    await flushLlmTelemetry();
  } catch {
    /* flush is best-effort */
  }

  if (!notify) {
    return { ran: true, summary, notified: 0 };
  }

  // Operational signal → surface to every operator (no per-user scope: this is
  // about the agent stack itself, not one tenant's data).
  const rows = await db.select({ id: user.id }).from(user);
  const userIds = rows.map((r) => r.id);
  await createNotificationsForUsers({
    userIds,
    type: "agent_health_alert",
    message: summary.slice(0, 500),
  });

  return { ran: true, summary, notified: userIds.length };
}
