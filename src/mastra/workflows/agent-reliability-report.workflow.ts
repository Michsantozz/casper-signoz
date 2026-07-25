import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Autonomous weekly reliability report — the fleet-health trend as a cron.
 *
 * Every Monday 09:00 this drives the read-only sreAgent to compare
 * CasperAgent's OWN SigNoz telemetry week-over-week (error rate + latency per
 * model/tool), rank the regressions, and notify configured operators with a
 * short digest. The self-host
 * counterpart to SigNoz Cloud's "Noz" service-reliability report — driven by our
 * agent over the MCP instead of a cloud-only UI. See
 * src/server/observability/agent-reliability-report.ts for the logic.
 *
 * Weekly (not the 15-min cadence of agent-health-watch): this is the TREND, not
 * an incident check — a week is the window it compares, so running it more often
 * would just re-report the same delta. concurrency:1 for safety. Safe no-op when
 * the SigNoz MCP is unwired (the agent has no telemetry tools).
 */
// Exported for unit-testing the step logic in isolation.
export const agentReliabilityReport = createStep({
  id: "agent-reliability-report",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ran: z.boolean(),
    summary: z.string(),
    notified: z.number(),
  }),
  execute: async () => {
    const { runAgentReliabilityReport } = await import(
      "@/server/observability/agent-reliability-report"
    );
    return runAgentReliabilityReport();
  },
});

export const agentReliabilityReportWorkflow = createWorkflow({
  id: "agent-reliability-report",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ran: z.boolean(),
    summary: z.string(),
    notified: z.number(),
  }),
  // Mastra-inngest cron contract: declare steps AND a static inputData so the
  // scheduled run validates (see meeting-reconcile.workflow.ts for the why).
  steps: [agentReliabilityReport],
  inputData: {},
  // Monday 09:00 — a start-of-week digest of the prior week's reliability.
  cron: "0 9 * * 1",
  concurrency: { limit: 1 },
  options: { validateInputs: false },
}).then(agentReliabilityReport);

agentReliabilityReportWorkflow.commit();
