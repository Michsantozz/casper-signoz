import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Meeting-minutes enrichment (event-driven, no human in the loop).
 *
 * The bot webhook (transcript.done) ENQUEUES the record and fires this workflow
 * via `inngest.send({ name: "workflow.meeting-enrich", data: { botId } })`, then
 * returns 200 immediately — it never blocks on the LLM/media work. Enrichment
 * runs durably here, off the request path, and shows up in the Inngest run log.
 *
 * The reconcile cron ([[meeting-reconcile.workflow]]) stays the SAFETY NET: if the
 * event is lost or the transcript wasn't ready yet, the stuck row is reprocessed
 * later. Idempotent by construction — enrichMeeting claims the record and skips
 * anything already "done", so a duplicate event or a cron overlap is a no-op.
 *
 * concurrency: dedups by botId — two events for the same meeting can't enrich in
 * parallel (the DB claim would already guard it, but this avoids the wasted run).
 */
// Exported for unit testing the step logic in isolation (see tests/unit/workflows).
export const enrich = createStep({
  id: "meeting-enrich",
  inputSchema: z.object({ botId: z.string() }),
  outputSchema: z.object({ state: z.string() }),
  execute: async ({ inputData }) => {
    const { enrichMeeting } = await import("@/server/recall/enrich");
    const result = await enrichMeeting(inputData.botId);
    return { state: result.state };
  },
});

export const meetingEnrichWorkflow = createWorkflow({
  id: "meeting-enrich",
  inputSchema: z.object({ botId: z.string() }),
  outputSchema: z.object({ state: z.string() }),
  concurrency: { limit: 1, key: "event.data.inputData.botId" },
}).then(enrich);

meetingEnrichWorkflow.commit();
