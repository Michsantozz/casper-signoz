import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Auto-scheduling of bots per calendar (no human in the loop).
 *
 * The reactive path schedules via the calendar.sync_events webhook. This cron is the SAFETY
 * NET: it scans all calendars with auto-record enabled (opt-in) and schedules
 * bots for upcoming events with a meeting_url — covering missed webhooks and
 * events created outside a sync window. Idempotent (dedup per event in
 * Recall), so running it again doesn't duplicate bots.
 *
 * Runs every 10 min.
 */
// Exported for unit testing the step logic in isolation (see tests/unit/workflows).
export const scan = createStep({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  execute: async () => {
    const { autoScheduleAll } = await import("@/server/recall/auto-schedule");
    return autoScheduleAll();
  },
});

export const autoScheduleWorkflow = createWorkflow({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  // Mastra-inngest cron contract: declare `steps` + a static `inputData` so the
  // scheduled run has real input. Without inputData the cron fires with
  // `input: undefined`, which mis-plans a duplicated update step ("Duplicate
  // step ID … across parallel chains") and never runs. `inputData: {}` matches
  // the empty schema.
  steps: [scan],
  inputData: {},
  cron: "*/10 * * * *",
  // Serializes runs: a slow scan must never overlap the next tick (10 min is
  // shorter than a full scan under load). Inngest queues the next run instead.
  concurrency: { limit: 1 },
  // Belt-and-suspenders: keep default input validation off for the empty-input
  // cron so a stray undefined can never re-trip the validation failure.
  options: { validateInputs: false },
}).then(scan);

autoScheduleWorkflow.commit();
