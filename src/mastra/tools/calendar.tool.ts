import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recallFetch } from "@/server/recall/client";
import { DEFAULT_TIME_ZONE } from "@/shared/lib/config";
import {
  listCalendarEvents,
  getCalendarAccessToken,
  type CalendarEvent,
} from "@/server/recall/calendars";
import { createGoogleEvent } from "@/server/recall/google-calendar";
import { getDayAvailability } from "@/server/recall/availability";
import {
  findCalendarById,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { saveBotMapping, defaultDedupKey } from "@/server/recall/bot-repository";
import { getSession } from "@/features/auth/model/session";
import { withUserScope } from "@/shared/db/rls";

/**
 * Calendar V2 tools for the meeting agent — scoped to the session user.
 *
 * The calendar owner is the authenticated user (better-auth). The tools
 * resolve the session server-side and only operate on calendars that belong
 * to them — the agent never receives nor trusts a user_id coming from chat.
 */

/** Resolves the session's user_id; throws if not authenticated (becomes a tool error). */
async function sessionUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error(
      "User not authenticated. Ask them to log in before using the calendar.",
    );
  }
  return session.user.id;
}

/** Ensures the calendar belongs to the user; throws otherwise. */
async function assertOwnedCalendar(
  calendarId: string,
  userId: string,
): Promise<void> {
  const mapping = await withUserScope(userId, () =>
    findCalendarById(calendarId),
  );
  if (!mapping || mapping.userId !== userId) {
    throw new Error("Calendar not found for this user.");
  }
}

/**
 * Event title from the raw provider payload. Recall doesn't promote the title
 * to a top-level field, but the list endpoint DOES return `raw` for every
 * event, so the title is already in hand — no per-event get_calendar_event
 * needed. Google puts it in `raw.summary`, Outlook in `raw.subject`.
 */
function eventTitle(e: CalendarEvent): string | null {
  const raw = e.raw ?? {};
  const summary = raw.summary;
  const subject = raw.subject;
  if (typeof summary === "string" && summary.trim()) return summary;
  if (typeof subject === "string" && subject.trim()) return subject;
  return null;
}

function projectEvent(e: CalendarEvent) {
  return {
    eventId: e.id,
    calendarId: e.calendar_id,
    // Title comes free with the list (raw.summary/raw.subject). Exposing it
    // here is what stops the agent from firing one get_calendar_event per event
    // just to learn each event's name.
    title: eventTitle(e),
    startTime: e.start_time,
    endTime: e.end_time,
    meetingUrl: e.meeting_url,
    platform: e.meeting_platform,
    scheduledBots: e.bots?.length ?? 0,
  };
}

/** Lists the upcoming events from the user's connected calendars. */
export const listCalendarEventsTool = createTool({
  id: "list_calendar_events",
  description:
    "Lists the upcoming events from the user's connected calendars (Google/Outlook). " +
    "Each event already includes its title, time, meeting link, and how many bots are " +
    "scheduled — enough to present the agenda directly. Do NOT call get_calendar_event " +
    "per event just to get titles; they are already here. " +
    "Use it so the user can choose which meeting to put the bot on.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe("Restricts to a specific calendar. Omit for all."),
  }),
  outputSchema: z.object({
    count: z.number(),
    events: z.array(
      z.object({
        eventId: z.string(),
        calendarId: z.string(),
        title: z.string().nullable(),
        startTime: z.string(),
        endTime: z.string(),
        meetingUrl: z.string().nullable(),
        platform: z.string().nullable(),
        scheduledBots: z.number(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    let calendarIds: string[];
    if (input.calendarId) {
      await assertOwnedCalendar(input.calendarId, userId);
      calendarIds = [input.calendarId];
    } else {
      const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
      calendarIds = mappings.map((m) => m.recallCalendarId);
    }

    // Window: from now until +30 days. start_time__lte avoids listing events
    // too far out (recurrences far in the future).
    const now = new Date();
    const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const events = (
      await Promise.all(
        calendarIds.map(async (cid) => {
          const { results } = await listCalendarEvents({
            calendarId: cid,
            isDeleted: false,
            startTimeGte: now.toISOString(),
            startTimeLte: horizon.toISOString(),
          });
          return results;
        }),
      )
    ).flat();

    const projected = events
      .map(projectEvent)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return { count: projected.length, events: projected };
  },
});

/**
 * Schedules (or updates) a bot for a calendar event. meeting_url and join_at
 * are filled in automatically by Recall from the event.
 */
export const scheduleBotForEventTool = createTool({
  id: "schedule_bot_for_event",
  description:
    "Schedules a Recall.ai bot to automatically join a user's connected-calendar event (by eventId). " +
    "The link and time come from the event itself. Calling it again on the same event updates the bot. " +
    "The bot joins without recording; the user can ask it to start recording later. " +
    "Prefer this over schedule_recall_bot whenever the meeting is a calendar event; use schedule_recall_bot only for a raw meeting link or a custom ad-hoc time.",
  inputSchema: z.object({
    eventId: z.string().describe("Calendar event ID (from list_calendar_events)"),
    botName: z
      .string()
      .optional()
      .describe('Name shown in the call. Recall default: "Meeting Notetaker".'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    scheduledBots: z.number(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    // Confirms ownership: fetches the event and validates its calendar belongs to the user.
    const event = await recallFetch<CalendarEvent>({
      method: "GET",
      path: `v2/calendar-events/${input.eventId}/`,
    });
    await assertOwnedCalendar(event.calendar_id, userId);

    const updated = await recallFetch<CalendarEvent>({
      method: "POST",
      path: `v2/calendar-events/${input.eventId}/bot/`,
      body: {
        deduplication_key: `${userId}:${input.eventId}`,
        bot_config: {
          ...(input.botName ? { bot_name: input.botName } : {}),
        },
      },
    });

    return {
      ok: true,
      eventId: updated.id,
      scheduledBots: updated.bots?.length ?? 0,
    };
  },
});

/** Removes the scheduled bot from a calendar event. */
export const removeBotFromEventTool = createTool({
  id: "remove_bot_from_event",
  description:
    "Removes the scheduled bot from a user's connected-calendar event (unschedules it), by eventId. " +
    "Use it when the user no longer wants to record that meeting. " +
    "For an ad-hoc bot you scheduled by meeting URL (you have a botId, not an eventId), use cancel_recall_bot instead.",
  inputSchema: z.object({
    eventId: z.string().describe("Calendar event ID"),
  }),
  outputSchema: z.object({ ok: z.boolean(), eventId: z.string() }),
  execute: async (input) => {
    const userId = await sessionUserId();

    const event = await recallFetch<CalendarEvent>({
      method: "GET",
      path: `v2/calendar-events/${input.eventId}/`,
    });
    await assertOwnedCalendar(event.calendar_id, userId);

    await recallFetch({
      method: "DELETE",
      path: `v2/calendar-events/${input.eventId}/bot/`,
    });
    return { ok: true, eventId: input.eventId };
  },
});

/**
 * Creates an event on the user's Google Calendar, with a Meet link by
 * default, and optionally sends a recording bot to that link right away.
 *
 * The access token comes from Recall (which manages refreshing the connected
 * calendar), so we don't store Google credentials. Requires the
 * calendar.events scope — if the calendar was connected with the old scope
 * (readonly), the user needs to reconnect to grant write permission.
 */
export const createCalendarEventTool = createTool({
  id: "create_calendar_event",
  description:
    "Creates a meeting on the user's Google Calendar (generates a Google Meet link by default) and, " +
    "if requested, sends a recording bot to the meeting right away. Requires a Google calendar connected with write permission. " +
    "Dates in ISO 8601 with timezone (e.g. 2026-06-25T10:00:00-03:00).",
  inputSchema: z.object({
    summary: z.string().describe("Meeting title"),
    startIso: z
      .string()
      .describe("Start time in ISO 8601 with timezone offset"),
    endIso: z.string().describe("End time in ISO 8601 with timezone offset"),
    timeZone: z
      .string()
      .optional()
      .describe('IANA tz, e.g. "America/Sao_Paulo". Optional if the ISO already has an offset.'),
    description: z.string().optional().describe("Description/agenda"),
    attendees: z
      .array(z.string())
      .optional()
      .describe("Attendee emails"),
    withMeet: z
      .boolean()
      .optional()
      .describe("Generate a Google Meet link. Default: true."),
    sendBot: z
      .boolean()
      .optional()
      .describe("If true, sends a recording bot to the created Meet link right away."),
    botName: z.string().optional().describe("Bot name in the call, if sendBot."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    htmlLink: z.string(),
    meetingUrl: z.string().nullable(),
    botId: z.string().nullable(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    // Resolves a connected Google calendar for the user to get the access token.
    const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
    const google = mappings.find((m) => m.platform === "google_calendar");
    if (!google) {
      throw new Error(
        "No Google calendar connected. Ask the user to connect their calendar.",
      );
    }

    const { token } = await getCalendarAccessToken(google.recallCalendarId);

    const event = await createGoogleEvent({
      accessToken: token,
      summary: input.summary,
      startIso: input.startIso,
      endIso: input.endIso,
      timeZone: input.timeZone,
      description: input.description,
      attendees: input.attendees,
      withMeet: input.withMeet ?? true,
    });

    // Optional: already sends an ad-hoc bot to the newly created Meet link.
    let botId: string | null = null;
    if (input.sendBot && event.meetingUrl) {
      const bot = await recallFetch<{ id: string }>({
        method: "POST",
        path: "v1/bot/",
        body: {
          meeting_url: event.meetingUrl,
          ...(input.botName ? { bot_name: input.botName } : {}),
          metadata: { event_id: event.id, user_id: userId },
        },
      });
      botId = bot.id;

      // Persists the bot with its owner (user_id) so the bot webhook knows who
      // to notify when the minutes are ready (transcript.done). Idempotent.
      await saveBotMapping({
        dedupKey: defaultDedupKey(userId, event.meetingUrl),
        botId: bot.id,
        meetingUrl: event.meetingUrl,
        metadata: { event_id: event.id, user_id: userId },
      });
    }

    return {
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      meetingUrl: event.meetingUrl,
      botId,
    };
  },
});

/**
 * Availability for a day: the business-hours grid already classified
 * (free/busy) against the user's real calendar. Mirrors what pick_date
 * shows in the chat — useful when the agent wants to SUGGEST a free time in
 * text (e.g. "tomorrow you have 9am, 11am and 3pm free") without opening the picker.
 */
export const getFreeSlotsTool = createTool({
  id: "get_free_slots",
  description:
    "Returns the FREE and BUSY time slots for a day, cross-referencing business hours (09:00-18:00) " +
    "with the user's connected calendar events. Use it to suggest free times in text or " +
    "to check whether a specific time is available before create_calendar_event. " +
    "If the user has no calendar connected, all (future) time slots come back as free.",
  inputSchema: z.object({
    dateIso: z.string().describe("Day to query (yyyy-mm-dd)"),
    timeZone: z
      .string()
      .optional()
      .describe('User\'s IANA tz, e.g. "America/Sao_Paulo" (default). BRT.'),
  }),
  outputSchema: z.object({
    dateIso: z.string(),
    timeZone: z.string(),
    noCalendar: z.boolean(),
    freeCount: z.number(),
    slots: z.array(
      z.object({
        timeHm: z.string(),
        datetimeIso: z.string(),
        busy: z.boolean(),
        reason: z.string().optional(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();
    const day = await getDayAvailability({
      userId,
      dateIso: input.dateIso,
      timeZone: input.timeZone || DEFAULT_TIME_ZONE,
    });
    return {
      dateIso: day.dateIso,
      timeZone: day.timeZone,
      noCalendar: day.noCalendar,
      freeCount: day.slots.filter((s) => !s.busy).length,
      slots: day.slots,
    };
  },
});

