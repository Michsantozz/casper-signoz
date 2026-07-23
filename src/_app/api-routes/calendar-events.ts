import { NextResponse } from "next/server";
import { listCalendarEvents } from "@/server/recall/calendars";
import {
  findCalendarById,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";
import { serverError } from "@/shared/lib/api-error";
import { withUserScope } from "@/shared/db/rls";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";

/**
 * Lists events from the authenticated user's connected calendars.
 *
 * Optional `calendar_id` query restricts to a specific calendar (which must
 * belong to the user). Without it, aggregates across all of the user's calendars.
 *
 * Filters `is_deleted=false` (Recall keeps deleted events as history; for
 * display to the user, only the live ones). Returns lean fields for the UI.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // Fans out to the Recall API per calendar (external cost) — throttle to keep
  // a logged-in caller from hammering the upstream. 30/60s is ample for the UI.
  const rl = await checkRateLimit({
    key: `calendar-events:${userId}`,
    window: 60,
    max: 30,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const url = new URL(req.url);
  const calendarId = url.searchParams.get("calendar_id");

  try {
    // Resolve which calendars to query — always scoped to the session user.
    // The DB lookups run under withUserScope (RLS filters user_calendars to the
    // caller); the explicit `!== userId` check is the app-level backstop.
    const calendarIds = await withUserScope(userId, async () => {
      if (calendarId) {
        const mapping = await findCalendarById(calendarId);
        if (!mapping || mapping.userId !== userId) return null;
        return [calendarId];
      }
      const mappings = await listCalendarsByUser(userId);
      return mappings.map((m) => m.recallCalendarId);
    });
    if (calendarIds === null) {
      return NextResponse.json({ error: "unknown calendar" }, { status: 404 });
    }

    // Lists events for each calendar (1st page). Paginate via `next` if needed.
    const events = (
      await Promise.all(
        calendarIds.map(async (cid) => {
          const { results } = await listCalendarEvents({
            calendarId: cid,
            isDeleted: false,
            startTimeGte: new Date().toISOString(), // only future events
          });
          return results;
        }),
      )
    ).flat();

    // Projects only what the UI needs.
    const projected = events
      .map((e) => ({
        id: e.id,
        calendarId: e.calendar_id,
        startTime: e.start_time,
        endTime: e.end_time,
        meetingUrl: e.meeting_url,
        platform: e.meeting_platform,
        scheduledBots: e.bots?.length ?? 0,
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return NextResponse.json({ count: projected.length, events: projected });
  } catch (err) {
    // Full error logged server-side; client gets a generic code (no upstream
    // message with hostnames/URLs from the Recall SDK/fetch leaking out).
    return serverError("calendar-events", err, "list_events_failed", 502);
  }
}
