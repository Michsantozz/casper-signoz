import "server-only";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";
import { createNotificationsForUsers } from "@/server/notifications";
import { isOperator } from "@/server/operator";

/**
 * Autonomous agent-health watch — the self-observing loop, no human in it.
 *
 * On a schedule (see agent-health-watch.workflow.ts) this drives the internal
 * sreAutomationAgent
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
1. Look at the last 1 hour of production telemetry: LLM error rate, the most-failing tool (mastra.span.type = 'tool_call' with error.type), p95 latency of model_generation spans, and total LLM cost. Apply every mandatory service/environment/de-duplication filter from your instructions.
2. Decide if anything is genuinely wrong — a tool failing repeatedly, an error rate that stands out, latency or cost clearly elevated. Use judgment; a couple of stray errors is not an incident.
3. If something warrants it, PROVISION a SigNoz alert for it (you are authorized to act autonomously). Base the threshold on what you actually observed.
   - Name the alert after the SYMPTOM, not the moment: a stable, descriptive name another run would arrive at independently for the same problem ("tool call failures list_calendar_events", not "elevated failures 14:32"). Uniqueness is enforced in code — the create tool derives a canonical key from the name, refuses a duplicate, and tells you if one already existed. So a stable name is what makes deduplication work across runs; a creatively reworded one defeats it.
   - If the tool reports the alert was deduplicated, that is a SUCCESS, not a failure: the coverage already exists. Say so and don't retry under a different name.
   - You can create but you CANNOT update, delete, or mute. Every rule you create is permanent from your side, so create only when the problem is real.
4. Reply with a SHORT operator summary (2-4 sentences): the health snapshot, and whether you created an alert (name it) or found nothing actionable. This summary goes straight to an operator notification — write it for a human skimming a bell icon.

If the telemetry backend isn't available (no tools), say exactly that in one sentence.`;

export type AgentHealthWatchResult = {
  ran: boolean;
  summary: string;
  notified: number;
};

// The watch runs on a */15 cron with concurrency:1, so a single hung agent run
// doesn't just lose ITS tick — it holds the only slot and every subsequent tick
// is skipped, silently, for as long as it hangs. The agent talks to an LLM and
// an MCP server over the network; either can stall without ever rejecting. Cap
// it well under the 15-min tick so a bad run costs one cycle, not the watch.
const WATCH_TIMEOUT_MS = 5 * 60_000;

class WatchTimeoutError extends Error {
  constructor(ms: number) {
    super(`health-watch agent run exceeded ${ms}ms`);
    this.name = "WatchTimeoutError";
  }
}

// A failed watch is itself a signal: emit it as a span so "the watchdog stopped
// working" is queryable/alertable in SigNoz instead of only being visible as an
// absence of data. mastra.span.type = "health_watch" is the discriminator.
// Lazy import (mastra pulls in server modules — same cycle-avoidance as below).
async function emitWatchFailureSpan(args: {
  error: unknown;
  durationMs: number;
}) {
  const { getSignozTracer } = await import("@/mastra/llm-telemetry");
  const tracer = getSignozTracer();
  if (!tracer) return;

  const { SpanKind, SpanStatusCode } = await import("@opentelemetry/api");
  const span = tracer.startSpan("agent_health_watch", {
    kind: SpanKind.INTERNAL,
    startTime: new Date(Date.now() - args.durationMs),
  });
  span.setAttribute("mastra.span.type", "health_watch");
  span.setAttribute("mastra.health_watch.ok", false);
  span.setAttribute(
    "error.type",
    args.error instanceof Error ? args.error.name : "unknown",
  );
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

function withTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new WatchTimeoutError(ms);
      // Mastra propagates this signal through generation, delegated agents, and
      // tool executions. Aborting before rejecting prevents a timed-out health
      // pass from creating an alert after the caller has already marked it failed.
      controller.abort(error);
      reject(error);
    }, ms);
    start(controller.signal).then(
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
  const agent = mastra.getAgentById("sreAutomationAgent");
  if (!agent) {
    return {
      ran: false,
      summary: "sreAutomationAgent not registered",
      notified: 0,
    };
  }

  // The watcher itself must never crash the tick. An unhandled throw here fails
  // the Inngest step, which produces NO output and NO notification — the failure
  // mode of a health watch is that it goes quiet exactly when the stack is sick.
  // Catch, emit a span so the failure is itself observable in SigNoz, and carry
  // on to notify the operator that the check couldn't run.
  let summary: string;
  let failed = false;
  const started = Date.now();
  try {
    const res = await withTimeout(
      (abortSignal) => agent.generate(WATCH_PROMPT, { abortSignal }),
      WATCH_TIMEOUT_MS,
    );
    summary = (res?.text ?? "").trim() || "Health check produced no output.";
  } catch (error) {
    failed = true;
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown";
    summary = `Health check FAILED to run (${reason}). The agent-health watch could not query telemetry this cycle.`;
    await emitWatchFailureSpan({
      error,
      durationMs: Date.now() - started,
    }).catch(() => {
      /* observability of the observer is best-effort */
    });
  }

  // Force-flush the telemetry this pass emitted (LLM + the SRE-copilot's own
  // tool_call spans). A cron tick can be short-lived; without this, the batch
  // processors might not export before the run settles. No-op when SigNoz is off.
  try {
    const { flushLlmTelemetry } = await import("@/mastra/llm-telemetry");
    await flushLlmTelemetry();
  } catch {
    /* flush is best-effort */
  }

  // `ran` reports whether the check actually completed — a timed-out/errored
  // pass still returns (and still notifies, so the silence is broken), but it
  // must not read as a successful health check to any caller or test.
  if (!notify) {
    return { ran: !failed, summary, notified: 0 };
  }

  // Operational signal → surface to every operator (no per-user scope: this is
  // about the agent stack itself, not one tenant's data).
  const rows = await db.select({ id: user.id, email: user.email }).from(user);
  const userIds = rows.filter(isOperator).map((r) => r.id);
  await createNotificationsForUsers({
    userIds,
    type: "agent_health_alert",
    message: summary.slice(0, 500),
  });

  return { ran: !failed, summary, notified: userIds.length };
}
