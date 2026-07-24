import "server-only";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";
import { createNotificationsForUsers } from "@/server/notifications";

/**
 * Autonomous weekly reliability report — the fleet-health digest, no human in it.
 *
 * On a schedule (see agent-reliability-report.workflow.ts) this drives the
 * sreAgent with a "compare this week to last week" prompt. The agent queries
 * CasperAgent's OWN SigNoz telemetry across TWO equal windows (current 7d vs the
 * prior 7d), ranks per-model / per-tool error-rate and latency REGRESSIONS, and
 * returns an operator-facing digest — surfaced as an in-app notification so the
 * loop is visible, not silent.
 *
 * This is the self-host equivalent of SigNoz Cloud's "Noz" service-reliability
 * report use-case: the same week-over-week regression ranking, driven by our own
 * agent over the MCP instead of a cloud-only UI. Distinct from the 15-min
 * agent-health-watch (a point-in-time incident check): this is the trend.
 *
 * Safe no-op when the SigNoz MCP isn't wired (SIGNOZ_MCP_URL unset): the agent
 * has no telemetry tools, says so, and we skip notifying.
 */

const REPORT_PROMPT = `WEEKLY RELIABILITY REPORT. You are running on a schedule, with no human in the loop, to summarize CasperAgent's own reliability week-over-week from its SigNoz telemetry.

Follow the RELIABILITY REPORT procedure from your instructions:
1. Compare the current 7 days against the prior 7 days (state both windows).
2. Per model (model_generation spans) and per tool (tool_call spans), aggregate error rate and p95/p99 latency in each window.
3. Rank by regression (current − prior). Lead with the single worst regression — the model/tool whose error rate or p95 climbed the most — with both numbers and the delta. Then one line on what improved or held steady.
4. If the prior window is empty, say so and give the current snapshot only — don't invent a delta.

Reply with a SHORT operator digest (3-6 sentences): the worst regression first, the overall shape of the week, and one Suggested Action for that worst regression. This goes straight to an operator notification — write it for a human skimming a bell icon. Do NOT dump raw JSON.

If the telemetry backend isn't available (no tools), say exactly that in one sentence.`;

export type AgentReliabilityReportResult = {
  ran: boolean;
  summary: string;
  notified: number;
};

/**
 * Runs one reliability-report pass. `notify` (default true) controls whether the
 * digest is fanned out as a notification — a manual demo trigger can turn it off
 * to just see the summary.
 */
export async function runAgentReliabilityReport(opts?: {
  notify?: boolean;
}): Promise<AgentReliabilityReportResult> {
  const notify = opts?.notify ?? true;

  // Lazy import to avoid a static server → mastra → server import cycle
  // (mastra/index pulls in server modules). Same pattern as agent-health-watch.
  const { mastra } = await import("@/mastra");
  const agent = mastra.getAgentById("sreAgent");
  if (!agent) {
    return { ran: false, summary: "sreAgent not registered", notified: 0 };
  }

  const res = await agent.generate(REPORT_PROMPT);
  const summary =
    (res?.text ?? "").trim() || "Reliability report produced no output.";

  if (!notify) {
    return { ran: true, summary, notified: 0 };
  }

  // Fleet-health digest → surface to every operator (no per-user scope: this is
  // about the agent stack itself, not one tenant's data).
  const rows = await db.select({ id: user.id }).from(user);
  const userIds = rows.map((r) => r.id);
  await createNotificationsForUsers({
    userIds,
    type: "agent_reliability_report",
    message: summary.slice(0, 500),
  });

  return { ran: true, summary, notified: userIds.length };
}
