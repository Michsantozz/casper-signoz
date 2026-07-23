import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Meeting poll-backfill (no human in the loop).
 *
 * The webhook (transcript.done) is the fast path that creates a meeting_record;
 * the reconcile cron reprocesses rows that got stuck. But BOTH only act on rows
 * that already exist — a webhook that never arrives leaves no row at all, and
 * the meeting is invisible forever.
 *
 * This cron asks Recall (the source of truth) for recent bots and enqueues any
 * with a ready transcript that we don't have yet. Idempotent by construction
 * (enqueue is onConflictDoNothing by botId), so it converges with the webhook
 * on the same row without duplicating.
 *
 * Runs every 15 min — a slow safety net, deliberately less frequent than the
 * 5-min reconcile: the webhook covers the common case, this only rescues the
 * lost-webhook tail. A bounded window (last 24h) + maxPages keeps each run cheap.
 */
// Exported for unit testing the step logic in isolation.
export const backfill = createStep({
  id: "meeting-backfill",
  inputSchema: z.object({}),
  outputSchema: z.object({
    scanned: z.number(),
    enqueued: z.number(),
    pages: z.number(),
  }),
  execute: async () => {
    const { backfillMissingMeetings } = await import(
      "@/server/recall/poll-backfill"
    );
    return backfillMissingMeetings();
  },
});

export const meetingBackfillWorkflow = createWorkflow({
  id: "meeting-backfill",
  inputSchema: z.object({}),
  outputSchema: z.object({
    scanned: z.number(),
    enqueued: z.number(),
    pages: z.number(),
  }),
  // Mastra-inngest cron contract: declare `steps` + a static `inputData` so the
  // scheduled run has real input. Without inputData the cron fires with
  // `input: undefined`, which mis-plans a duplicated update step ("Duplicate
  // step ID … across parallel chains") and never runs. `inputData: {}` matches
  // the empty schema.
  steps: [backfill],
  inputData: {},
  cron: "*/15 * * * *",
  // Serialize runs so a slow scan can't overlap the next tick and double-scan.
  concurrency: { limit: 1 },
  // Belt-and-suspenders: keep default input validation off for the empty-input
  // cron so a stray undefined can never re-trip the validation failure.
  options: { validateInputs: false },
}).then(backfill);

meetingBackfillWorkflow.commit();
