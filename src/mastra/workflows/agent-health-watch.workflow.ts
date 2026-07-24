import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Autonomous agent-health watch — the self-observing loop as a cron.
 *
 * Every 15 min this drives the sreAgent to inspect CasperAgent's OWN SigNoz
 * telemetry and, where a real problem stands out, provision a SigNoz alert for
 * it (idempotently) — then notify the operator with a short summary. No human
 * asks; the agent watches and repairs its own instrumentation on a schedule.
 * See src/server/observability/agent-health-watch.ts for the logic.
 *
 * 15 min: frequent enough to catch a regression within the hour it queries,
 * infrequent enough not to spend tokens in a tight loop. concurrency:1 so a slow
 * agent run can't overlap the next tick. Safe no-op when the SigNoz MCP is
 * unwired (the agent has no telemetry tools).
 */
// Exported for unit-testing the step logic in isolation.
export const agentHealthWatch = createStep({
  id: "agent-health-watch",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ran: z.boolean(),
    summary: z.string(),
    notified: z.number(),
  }),
  execute: async () => {
    const { runAgentHealthWatch } = await import(
      "@/server/observability/agent-health-watch"
    );
    return runAgentHealthWatch();
  },
});

export const agentHealthWatchWorkflow = createWorkflow({
  id: "agent-health-watch",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ran: z.boolean(),
    summary: z.string(),
    notified: z.number(),
  }),
  // Mastra-inngest cron contract: declare steps AND a static inputData so the
  // scheduled run validates (see meeting-reconcile.workflow.ts for the why).
  steps: [agentHealthWatch],
  inputData: {},
  cron: "*/15 * * * *",
  concurrency: { limit: 1 },
  options: { validateInputs: false },
}).then(agentHealthWatch);

agentHealthWatchWorkflow.commit();
