import { Mastra } from "@mastra/core";
import { assistantAgent } from "./agents/assistant.agent";
import { minutesAgent } from "./agents/minutes.agent";
import { searchAgent } from "./agents/search.agent";
import { sreAgent, sreAutomationAgent } from "./agents/sre.agent";
import { meetingReconcileWorkflow } from "./workflows/meeting-reconcile.workflow";
import { meetingEnrichWorkflow } from "./workflows/meeting-enrich.workflow";
import { meetingBackfillWorkflow } from "./workflows/meeting-backfill.workflow";
import { autoScheduleWorkflow } from "./workflows/auto-schedule.workflow";
import { oauthNonceSweepWorkflow } from "./workflows/oauth-nonce-sweep.workflow";
import { agentHealthWatchWorkflow } from "./workflows/agent-health-watch.workflow";
import { agentReliabilityReportWorkflow } from "./workflows/agent-reliability-report.workflow";
import { getMastraStore } from "./storage";
import { createObservability } from "./observability";

export const mastra = new Mastra({
  // assistantAgent is the SUPERVISOR (scheduling + calendar + bot control); it
  // delegates to minutesAgent (per-meeting minutes) and searchAgent (cross-
  // meeting history). sreAgent is the operator-only, read-only SRE copilot;
  // sreAutomationAgent is internal-only and holds the narrowly scoped SigNoz
  // create capabilities used by the health loop.
  agents: {
    assistantAgent,
    minutesAgent,
    searchAgent,
    sreAgent,
    sreAutomationAgent,
  },
  workflows: {
    meetingReconcileWorkflow,
    meetingEnrichWorkflow,
    meetingBackfillWorkflow,
    autoScheduleWorkflow,
    oauthNonceSweepWorkflow,
    agentHealthWatchWorkflow,
    agentReliabilityReportWorkflow,
  },
  // Persists traces, telemetry and workflow state in the app's PG (schema
  // `mastra`). Without this the cron would run stateless.
  storage: getMastraStore(),
  // Traces + model-generation spans + the human-feedback pipeline (👍/👎 from
  // the chat land here via observability.addFeedback). Without it, feedback is
  // a NoOp. SensitiveDataFilter is auto-applied so span text is scrubbed.
  observability: createObservability(),
});
