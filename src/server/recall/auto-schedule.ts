import "server-only";
import { recallFetch } from "@/server/recall/client";
import { listCalendarEvents, type CalendarEvent } from "@/server/recall/calendars";
import { listAutoRecordCalendars } from "@/server/recall/calendar-repository";
import { withSystemScope } from "@/shared/db/rls";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("auto-schedule");

/**
 * Auto-scheduling of bots per calendar (opt-in).
 *
 * For each calendar with auto-record enabled, schedules a Recall bot on the
 * upcoming events that have a meeting_url. Idempotent: Recall deduplicates by
 * deduplication_key per event, so running it again doesn't create a duplicate bot.
 *
 * Triggered by two paths:
 *  - the calendar.sync_events webhook (reacts to calendar changes);
 *  - the periodic sweep cron (safety net if the webhook fails).
 */

/** Look-ahead window to schedule (min). Events beyond this are left for later. */
const HORIZON_MINUTES = Number(process.env.AUTO_SCHEDULE_HORIZON_MINUTES ?? 60);

export interface AutoScheduleResult {
  calendarId: string;
  scheduled: number;
  skippedNoUrl: number;
}

/**
 * Schedules bots for the upcoming events (with meeting_url) of ONE calendar.
 * Takes the owner for the deduplication_key. Doesn't open a db scope around
 * the REST call.
 */
export async function autoScheduleForCalendar(input: {
  calendarId: string;
  userId: string;
}): Promise<AutoScheduleResult> {
  const now = Date.now();
  const horizon = new Date(now + HORIZON_MINUTES * 60_000).toISOString();

  const { results } = await listCalendarEvents({
    calendarId: input.calendarId,
    isDeleted: false,
    startTimeGte: new Date(now).toISOString(),
    startTimeLte: horizon,
  });

  let scheduled = 0;
  let skippedNoUrl = 0;

  for (const event of results as CalendarEvent[]) {
    if (!event.meeting_url) {
      skippedNoUrl++;
      continue;
    }
    // Already has a bot scheduled on this event? Recall dedups by key, but we
    // avoid the call when the event itself already reports bots.
    if ((event.bots?.length ?? 0) > 0) continue;

    await recallFetch({
      method: "POST",
      path: `v2/calendar-events/${event.id}/bot/`,
      body: {
        deduplication_key: `${input.userId}:${event.id}`,
        bot_config: {
          metadata: { user_id: input.userId, auto_scheduled: "true" },
        },
      },
    });
    scheduled++;
  }

  return {
    calendarId: input.calendarId,
    scheduled,
    skippedNoUrl,
  };
}

/**
 * Walks all calendars with auto-record enabled and schedules bots. Called by
 * the cron. Reads the list under system scope (crosses users); each calendar
 * schedules with its own owner.
 */
export async function autoScheduleAll(): Promise<{
  calendars: number;
  scheduled: number;
}> {
  const calendars = await withSystemScope(() => listAutoRecordCalendars());
  let scheduled = 0;
  for (const cal of calendars) {
    // Isolate per-calendar failures: one broken calendar must not abort the
    // whole cron tick. Log it (don't swallow silently) so a persistently
    // failing calendar is visible to operators instead of failing invisibly.
    const res = await autoScheduleForCalendar({
      calendarId: cal.recallCalendarId,
      userId: cal.userId,
    }).catch((err) => {
      log.warn(
        {
          recallCalendarId: cal.recallCalendarId,
          userId: cal.userId,
          err: err instanceof Error ? err.message : err,
        },
        "calendar scheduling failed",
      );
      return null;
    });
    if (res) scheduled += res.scheduled;
  }
  return { calendars: calendars.length, scheduled };
}
