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

// The report drives the sreAgent, which talks to an LLM and the SigNoz MCP over
// the network — either can stall WITHOUT ever rejecting. A bare `await` on a hung
// generate() never returns: the Inngest step neither completes nor errors, so the
// weekly digest produces NO output and NO notification, going silent exactly when
// the stack it reports on is unhealthy. Cap it. Heavier than the 15-min health
// watch (it aggregates two 7-day windows), so a larger bound — but still bounded.
// Mirrors the hardening in agent-health-watch.ts.
const REPORT_TIMEOUT_MS = 10 * 60_000;

class ReportTimeoutError extends Error {
  constructor(ms: number) {
    super(`reliability-report agent run exceeded ${ms}ms`);
    this.name = "ReportTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReportTimeoutError(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

// A failed report is itself a signal: emit it as a span so "the weekly digest
// stopped working" is queryable in SigNoz instead of only showing up as a missing
// notification. mastra.span.type = "reliability_report" is the discriminator.
// Lazy import (mastra pulls in server modules — same cycle-avoidance as below).
async function emitReportFailureSpan(args: {
  error: unknown;
  durationMs: number;
}) {
  const { getSignozTracer } = await import("@/mastra/llm-telemetry");
  const tracer = getSignozTracer();
  if (!tracer) return;

  const { SpanKind, SpanStatusCode } = await import("@opentelemetry/api");
  const span = tracer.startSpan("agent_reliability_report", {
    kind: SpanKind.INTERNAL,
    startTime: new Date(Date.now() - args.durationMs),
  });
  span.setAttribute("mastra.span.type", "reliability_report");
  span.setAttribute("mastra.reliability_report.ok", false);
  span.setAttribute(
    "error.type",
    args.error instanceof Error ? args.error.name : "unknown",
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

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

  // The report itself must never hang or crash the tick. A bare throw/hang here
  // fails the Inngest step with no output and no notification — the failure mode
  // of a health digest is that it goes quiet exactly when the stack is sick.
  // Bound it, catch, emit a span so the failure is itself observable, and carry on
  // to notify the operator that the report couldn't run.
  let summary: string;
  let failed = false;
  const started = Date.now();
  try {
    const res = await withTimeout(
      agent.generate(REPORT_PROMPT),
      REPORT_TIMEOUT_MS,
    );
    summary =
      (res?.text ?? "").trim() || "Reliability report produced no output.";
  } catch (error) {
    failed = true;
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
    summary = `Reliability report FAILED to run (${reason}). The week-over-week digest could not query telemetry this cycle.`;
    await emitReportFailureSpan({
      error,
      durationMs: Date.now() - started,
    }).catch(() => {
      /* observability of the observer is best-effort */
    });
  }

  // Force-flush the telemetry this pass emitted (the SRE-copilot's own LLM +
  // tool_call spans). A cron tick can be short-lived; without this the batch
  // processors might not export before the run settles. No-op when SigNoz is off.
  try {
    const { flushLlmTelemetry } = await import("@/mastra/llm-telemetry");
    await flushLlmTelemetry();
  } catch {
    /* flush is best-effort */
  }

  // `ran` reports whether the report actually completed — a timed-out/errored
  // pass still returns (and still notifies, so the silence is broken), but it
  // must not read as a successful report to any caller or test.
  if (!notify) {
    return { ran: !failed, summary, notified: 0 };
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

  return { ran: !failed, summary, notified: userIds.length };
}
