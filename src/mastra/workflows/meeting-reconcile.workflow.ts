import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Meeting minutes reconciliation (no human in the loop).
 *
 * The happy path generates the minutes in the bot webhook (transcript.done). This cron is the
 * SAFETY NET: if the webhook got lost, arrived before the transcript was
 * ready, or the enrichment failed transiently, the row in meeting_records
 * stays "pending"/"processing". Here we scan the stuck ones and reprocess them — durable
 * by construction (each tick is a new attempt).
 *
 * Runs every 5 min. staleMs=15min (≈3× the cron, aligned with claim's
 * staleProcessingMs): only reprocesses rows stuck long enough that a live
 * webhook-enrich would already have finished, so we never race a running
 * enrichment. A slow-but-alive run stays untouched until it's genuinely stale.
 */
// Exported for unit testing the step logic in isolation (see tests/unit/workflows).
export const reconcile = createStep({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  execute: async () => {
    const { reconcileStuckMeetings } = await import("@/server/recall/enrich");
    return reconcileStuckMeetings(15 * 60_000);
  },
});

export const meetingReconcileWorkflow = createWorkflow({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  // The Mastra-inngest cron contract (per the official inngest guide): a
  // scheduled workflow must declare its `steps` AND a static `inputData`.
  // Without inputData the cron fires with `input: undefined`, which the engine
  // both fails to validate ("Step input validation failed") and mis-plans into
  // a duplicated update step ("Duplicate step ID … across parallel chains") —
  // so the cron never actually runs. `inputData: {}` satisfies the empty schema.
  steps: [reconcile],
  inputData: {},
  cron: "*/5 * * * *",
  // Serializes runs: reconcile sweeps every stuck row and can outlast the 5-min
  // tick. concurrency:1 makes Inngest queue the next tick instead of running two
  // sweeps in parallel (which would double-claim the same records).
  concurrency: { limit: 1 },
  // Belt-and-suspenders: keep default input validation off for the empty-input
  // cron so a stray undefined can never re-trip the validation failure.
  options: { validateInputs: false },
}).then(reconcile);

meetingReconcileWorkflow.commit();
