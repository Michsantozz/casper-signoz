import "server-only";
/**
 * Google Calendar API — event creation (write).
 *
 * Uses an OAuth access token (obtained via Recall, which manages the refresh).
 * Creates events on the user's primary calendar, optionally with a Google Meet
 * link (conferenceData.createRequest + conferenceDataVersion=1).
 *
 * Docs: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export type CreatedEvent = {
  id: string;
  htmlLink: string;
  /** Meet link, if requested (entryPoints[type=video]). */
  meetingUrl: string | null;
  start: string;
  end: string;
  summary: string;
};

type CreateEventInput = {
  accessToken: string;
  summary: string;
  /** ISO 8601 with offset, e.g.: 2026-06-25T10:00:00-03:00. */
  startIso: string;
  endIso: string;
  timeZone?: string;
  description?: string;
  attendees?: string[];
  /** Generates a Google Meet link on the event. Default: true. */
  withMeet?: boolean;
};

/** Creates an event on the primary calendar and returns the Meet link (if requested). */
export async function createGoogleEvent(
  input: CreateEventInput,
): Promise<CreatedEvent> {
  const withMeet = input.withMeet ?? true;

  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startIso, timeZone: input.timeZone },
    end: { dateTime: input.endIso, timeZone: input.timeZone },
    attendees: input.attendees?.map((email) => ({ email })),
    ...(withMeet
      ? {
          conferenceData: {
            createRequest: {
              // requestId must be unique per request; derived from summary+start.
              requestId: `meet-${input.summary}-${input.startIso}`.slice(0, 64),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
  };

  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  if (withMeet) url.searchParams.set("conferenceDataVersion", "1");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    id?: string;
    htmlLink?: string;
    hangoutLink?: string;
    conferenceData?: {
      entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    };
    start?: { dateTime?: string };
    end?: { dateTime?: string };
    summary?: string;
    error?: { message?: string };
  };

  if (!res.ok || !data.id) {
    throw new Error(
      `Google Calendar insert failed: ${data.error?.message ?? res.status}`,
    );
  }

  const videoEntry = data.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video",
  );
  const meetingUrl = data.hangoutLink ?? videoEntry?.uri ?? null;

  return {
    id: data.id,
    htmlLink: data.htmlLink ?? "",
    meetingUrl,
    start: data.start?.dateTime ?? input.startIso,
    end: data.end?.dateTime ?? input.endIso,
    summary: data.summary ?? input.summary,
  };
}
