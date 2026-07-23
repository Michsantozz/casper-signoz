import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { scopedDb } from "@/shared/db/rls";
import { userCalendars, type UserCalendarRow } from "@/shared/db/schema";

/**
 * Repository for the Recall user → calendar map (capability boundary).
 *
 * The OAuth routes query here before creating (dedup by email+platform) and
 * persist the calendar.id afterward. The webhook handler updates the status.
 */

/** Calendar already mapped to (platform, platformEmail), or null. */
export async function findCalendarByEmail(
  platform: string,
  platformEmail: string,
): Promise<UserCalendarRow | null> {
  const rows = await scopedDb()
    .select()
    .from(userCalendars)
    .where(
      and(
        eq(userCalendars.platform, platform),
        eq(userCalendars.platformEmail, platformEmail),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Calendar by Recall id, or null. */
export async function findCalendarById(
  recallCalendarId: string,
): Promise<UserCalendarRow | null> {
  const rows = await scopedDb()
    .select()
    .from(userCalendars)
    .where(eq(userCalendars.recallCalendarId, recallCalendarId))
    .limit(1);
  return rows[0] ?? null;
}

/** All calendars of a user. */
export async function listCalendarsByUser(
  userId: string,
): Promise<UserCalendarRow[]> {
  return scopedDb()
    .select()
    .from(userCalendars)
    .where(eq(userCalendars.userId, userId));
}

/**
 * Upserts the mapping. Idempotent by recallCalendarId (PK): on conflict,
 * updates the user link, status, and email.
 */
export async function saveCalendarMapping(input: {
  recallCalendarId: string;
  userId: string;
  platform: string;
  platformEmail?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await scopedDb()
    .insert(userCalendars)
    .values({
      recallCalendarId: input.recallCalendarId,
      userId: input.userId,
      platform: input.platform,
      platformEmail: input.platformEmail ?? null,
      status: input.status ?? null,
      metadata: input.metadata,
    })
    .onConflictDoUpdate({
      target: userCalendars.recallCalendarId,
      set: {
        userId: input.userId,
        platformEmail: input.platformEmail ?? null,
        status: input.status ?? null,
        updatedAt: new Date(),
      },
    });
}

/** Updates only the status (used by the webhook handler). */
export async function updateCalendarStatus(
  recallCalendarId: string,
  status: string,
): Promise<void> {
  await scopedDb()
    .update(userCalendars)
    .set({ status, updatedAt: new Date() })
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/** Removes the mapping of a calendar (after disconnecting in Recall). */
export async function deleteCalendarMapping(
  recallCalendarId: string,
): Promise<void> {
  await scopedDb()
    .delete(userCalendars)
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/**
 * Toggles AUTOMATIC recording (opt-in) of a calendar. When enabled, the
 * scheduler schedules bots for the upcoming events with meeting_url — without
 * explicit per-event consent. Stored in metadata.auto_record (no extra migration).
 */
export async function setCalendarAutoRecord(
  recallCalendarId: string,
  autoRecord: boolean,
): Promise<void> {
  await scopedDb()
    .update(userCalendars)
    .set({
      // jsonb_build_object binds `autoRecord` as a parameter — no sql.raw, so
      // there's no string-interpolation sink to widen into an injection later.
      metadata: sql`coalesce(${userCalendars.metadata}, '{}'::jsonb) || jsonb_build_object('auto_record', ${autoRecord})`,
      updatedAt: new Date(),
    })
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/**
 * Calendars with auto-record enabled, across ALL users. For the
 * auto-scheduling cron (runs under system scope). Filters by metadata.auto_record.
 */
export async function listAutoRecordCalendars(): Promise<UserCalendarRow[]> {
  return scopedDb()
    .select()
    .from(userCalendars)
    .where(sql`${userCalendars.metadata}->>'auto_record' = 'true'`);
}
