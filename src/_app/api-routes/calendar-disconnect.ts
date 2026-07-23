import { NextResponse } from "next/server";
import { recallFetch } from "@/server/recall/client";
import {
  findCalendarById,
  deleteCalendarMapping,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";
import { withUserScope } from "@/shared/db/rls";

/**
 * Disconnects the authenticated user's calendar(s).
 *
 * Optional body `{ calendarId }` disconnects a specific calendar (which must
 * belong to the user). Without it, disconnects all of the user's calendars.
 * Deletes in Recall (DELETE /v2/calendars/{id}) and removes the mapping in the DB.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}) as { calendarId?: string });
  const calendarId = (body as { calendarId?: string }).calendarId;

  // Resolve which calendars to disconnect — always scoped to the user. The DB
  // lookups run under withUserScope (RLS filters user_calendars to the caller);
  // the explicit `!== userId` check is the app-level backstop.
  const targets = await withUserScope(userId, async () => {
    if (calendarId) {
      const mapping = await findCalendarById(calendarId);
      if (!mapping || mapping.userId !== userId) return null;
      return [calendarId];
    }
    const mappings = await listCalendarsByUser(userId);
    return mappings.map((m) => m.recallCalendarId);
  });
  if (targets === null) {
    return NextResponse.json({ error: "unknown calendar" }, { status: 404 });
  }

  let removed = 0;
  for (const id of targets) {
    try {
      await recallFetch({ method: "DELETE", path: `v2/calendars/${id}/` });
    } catch {
      // Even if Recall already removed it, we clean up the local mapping.
    }
    // Under the user scope so the RLS policy authorizes the delete (owned row).
    await withUserScope(userId, () => deleteCalendarMapping(id));
    removed += 1;
  }

  return NextResponse.json({ ok: true, removed });
}
