import "server-only";
import { recallFetch } from "./client";

/**
 * Recall.ai Calendar V2 operations (multi-user).
 *
 * Capability boundary: these functions talk to the Recall REST API via
 * `recallFetch`. Persistence of the user↔calendar map lives in the repository
 * (calendar-repository.ts); the provider OAuth lives in the routes.
 */

export type CalendarPlatform = "google_calendar" | "microsoft_outlook";

export type RecallCalendar = {
  id: string;
  platform: CalendarPlatform;
  platform_email: string | null;
  status: string;
  status_changes: Array<{ status: string; created_at: string }>;
  oauth_email?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type CreateCalendarInput = {
  platform: CalendarPlatform;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRefreshToken: string;
  /** Email of the authorized account (helps Recall populate platform_email). */
  oauthEmail?: string;
  /** URL where Recall sends calendar/event update webhooks. */
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
};

/** Creates a calendar in Recall from the user's OAuth refresh_token. */
export async function createCalendar(
  input: CreateCalendarInput,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "POST",
    path: "v2/calendars/",
    body: {
      platform: input.platform,
      oauth_client_id: input.oauthClientId,
      oauth_client_secret: input.oauthClientSecret,
      oauth_refresh_token: input.oauthRefreshToken,
      oauth_email: input.oauthEmail,
      webhook_url: input.webhookUrl,
      metadata: input.metadata,
    },
  });
}

/** Updates the refresh_token of an existing calendar (reconnection). */
export async function reconnectCalendar(
  calendarId: string,
  input: Pick<
    CreateCalendarInput,
    "oauthClientId" | "oauthClientSecret" | "oauthRefreshToken" | "oauthEmail"
  >,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "PATCH",
    path: `v2/calendars/${calendarId}/`,
    body: {
      oauth_client_id: input.oauthClientId,
      oauth_client_secret: input.oauthClientSecret,
      oauth_refresh_token: input.oauthRefreshToken,
      oauth_email: input.oauthEmail,
    },
  });
}

/** Deletes a provider calendar, used to compensate a failed local link write. */
export async function deleteCalendar(calendarId: string): Promise<void> {
  await recallFetch({ method: "DELETE", path: `v2/calendars/${calendarId}/` });
}

/** Lists workspace calendars, optionally filtering by email/platform. */
export async function listCalendars(query?: {
  platformEmail?: string;
  platform?: CalendarPlatform;
}): Promise<RecallCalendar[]> {
  const res = await recallFetch<{ results: RecallCalendar[] }>({
    method: "GET",
    path: "v2/calendars/",
    query: {
      platform_email: query?.platformEmail,
      platform: query?.platform,
    },
  });
  return res.results ?? [];
}

/** Reads a calendar by id. */
export async function retrieveCalendar(
  calendarId: string,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "GET",
    path: `v2/calendars/${calendarId}/`,
  });
}

/**
 * Obtains a Google OAuth access token for the connected calendar.
 *
 * Recall manages the token refresh from the refresh_token we gave it at
 * creation time — so we don't need to store/renew Google credentials: we
 * request a fresh access token here and use it directly against the Google
 * Calendar API.
 */
export async function getCalendarAccessToken(
  calendarId: string,
): Promise<{ token: string; expiresAt: string }> {
  const res = await recallFetch<{ token: string; expires_at: string }>({
    method: "POST",
    path: `v2/calendars/${calendarId}/access-token/`,
  });
  return { token: res.token, expiresAt: res.expires_at };
}

export type CalendarEvent = {
  id: string;
  calendar_id: string;
  platform_id: string;
  ical_uid: string;
  start_time: string;
  end_time: string;
  is_deleted: boolean;
  /** Meeting link extracted from the event (null if none). */
  meeting_url: string | null;
  meeting_platform: string | null;
  /** Bots already scheduled for this event (empty if none). */
  bots: Array<{ bot_id: string; start_time?: string }>;
  raw: Record<string, unknown>;
};

type ListEventsQuery = {
  calendarId: string;
  /** Only live events (recommended for displaying to the user). */
  isDeleted?: boolean;
  /** ISO 8601 — events changed since this ts (incremental sync). */
  updatedAtGte?: string;
  /** ISO 8601 — start-time window. */
  startTimeGte?: string;
  startTimeLte?: string;
  cursor?: string;
};

/**
 * Lists events of a calendar (one page).
 *
 * Endpoint uses a hyphen: /api/v2/calendar-events/. To paginate, pass through
 * `next` (the full URL) without changing the query params — or use the
 * extracted `cursor`. Rate limit: 60 req/min per workspace.
 */
export async function listCalendarEvents(
  query: ListEventsQuery,
): Promise<{ results: CalendarEvent[]; next: string | null }> {
  const res = await recallFetch<{
    results: CalendarEvent[];
    next: string | null;
    previous: string | null;
  }>({
    method: "GET",
    path: "v2/calendar-events/",
    query: {
      calendar_id: query.calendarId,
      is_deleted: query.isDeleted === undefined ? undefined : String(query.isDeleted),
      updated_at__gte: query.updatedAtGte,
      start_time__gte: query.startTimeGte,
      start_time__lte: query.startTimeLte,
      cursor: query.cursor,
    },
  });
  return { results: res.results ?? [], next: res.next ?? null };
}
