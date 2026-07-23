import "server-only";
import { listCalendarEvents } from "./calendars";
import { listCalendarsByUser } from "./calendar-repository";
import { withUserScope } from "@/shared/db/rls";

/**
 * Availability engine — computes FREE TIME SLOTS by crossing the business-hours
 * grid with the real events of the user's connected calendars.
 *
 * Before this, pick_date in the chat showed a fixed 09:00–18:00 grid that
 * IGNORED the calendar: the user would click an already-busy slot and
 * create_calendar_event would create a silent conflict. Here we derive the
 * "busy ranges" (existing events, synced via Recall) and subtract them from
 * the grid, marking each slot as free or busy — the UI becomes honest.
 *
 * Interval algebra inspired by cal.com (buildDateRanges + subtract), but
 * lean: here we only need to know, for a single DAY, which slots hit some
 * event. There's no per-user working-hours, date overrides, or round-robin.
 */

/** Half-open interval [start, end) in epoch ms. */
export type Range = { start: number; end: number };

/** A grid slot, already classified against the calendar. */
export type Slot = {
  /** Time in "HH:mm" format (request's timezone). */
  timeHm: string;
  /** Local ISO "yyyy-mm-ddTHH:mm" — what the agent uses as join_at. */
  datetimeIso: string;
  /** true if it collides with some existing event (or is already in the past). */
  busy: boolean;
  /** Reason for busy, when present (title/window of the conflicting event). */
  reason?: string;
};

export type AvailabilityDay = {
  /** Queried day (yyyy-mm-dd) in the request's timezone. */
  dateIso: string;
  /** IANA tz used in the computation (e.g.: "America/Sao_Paulo"). */
  timeZone: string;
  slots: Slot[];
  /** true if the user has no calendar connected at all (everything becomes "free"). */
  noCalendar: boolean;
};

/** Business-hours grid — fixed (the agent doesn't widen it). */
const BUSINESS_START_MIN = 9 * 60; // 09:00
const BUSINESS_END_MIN = 18 * 60; // 18:00
const SLOT_STEP_MIN = 60;
/** Assumed duration of a slot when checking for conflict (same as the step). */
const SLOT_DURATION_MIN = SLOT_STEP_MIN;

/**
 * Merges overlapping/adjacent ranges. Sorts by start and merges when the next
 * one starts before (or at) the current one's end. O(n log n).
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** true if [start, end) intersects any of the busy ranges (assumes sorted/merged). */
export function overlaps(start: number, end: number, busy: Range[]): boolean {
  for (const b of busy) {
    if (b.start >= end) break; // sorted: nothing further crosses
    if (b.end > start) return true; // b.start < end && b.end > start
  }
  return false;
}

/**
 * Offset (in minutes) of the `timeZone` at a given instant. Positive = east of
 * UTC. Uses Intl to respect DST — like cal.com, we avoid tz libraries.
 */
function tzOffsetMinutes(timeZone: string, at: Date): number {
  // Formats the instant in the target timezone and reconstructs a Date "as if
  // it were UTC"; the difference to the real instant is the offset.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(at);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Intl sometimes returns hour=24 at midnight; normalize.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    hour,
    map.minute,
    map.second,
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Converts a local wall-clock time (day + minutes-of-day in `timeZone`) to
 * epoch ms. Resolves the offset iteratively (2 passes are enough for DST).
 */
function localWallToEpoch(
  dateIso: string,
  minutesOfDay: number,
  timeZone: string,
): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesOfDay * 60000;
  // 1st pass: offset at the naive instant; 2nd: re-evaluates at the corrected instant.
  let offset = tzOffsetMinutes(timeZone, new Date(naiveUtc));
  let epoch = naiveUtc - offset * 60000;
  offset = tzOffsetMinutes(timeZone, new Date(epoch));
  epoch = naiveUtc - offset * 60000;
  return epoch;
}

function hm(minutesOfDay: number): string {
  const h = String(Math.floor(minutesOfDay / 60)).padStart(2, "0");
  const m = String(minutesOfDay % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Fetches the events of the user's calendars that fall on the requested day
 * and turns them into busy ranges (epoch ms), already merged. Scoped to the user.
 *
 * An event is included if its window [start, end) intersects the local day —
 * that's why we query with a ±1 day margin in the Recall query and filter here.
 */
async function getBusyRangesForDay(
  userId: string,
  dateIso: string,
  timeZone: string,
): Promise<{ busy: Range[]; events: Array<{ range: Range; title: string }>; noCalendar: boolean }> {
  const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
  if (mappings.length === 0) {
    return { busy: [], events: [], noCalendar: true };
  }

  const dayStart = localWallToEpoch(dateIso, 0, timeZone);
  const dayEnd = localWallToEpoch(dateIso, 24 * 60, timeZone);
  // 1-day margin on each side to catch events that cross the boundary.
  const queryFrom = new Date(dayStart - 24 * 60 * 60 * 1000).toISOString();
  const queryTo = new Date(dayEnd + 24 * 60 * 60 * 1000).toISOString();

  const allEvents = (
    await Promise.all(
      mappings.map(async (m) => {
        const { results } = await listCalendarEvents({
          calendarId: m.recallCalendarId,
          isDeleted: false,
          startTimeGte: queryFrom,
          startTimeLte: queryTo,
        });
        return results;
      }),
    )
  ).flat();

  const events: Array<{ range: Range; title: string }> = [];
  for (const e of allEvents) {
    const start = Date.parse(e.start_time);
    const end = Date.parse(e.end_time);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // Only what actually intersects the local day.
    if (end <= dayStart || start >= dayEnd) continue;
    const title =
      (typeof e.raw?.summary === "string" && e.raw.summary) ||
      (e.meeting_platform ? `meeting (${e.meeting_platform})` : "busy event");
    events.push({ range: { start, end }, title });
  }

  const busy = mergeRanges(events.map((e) => e.range));
  return { busy, events, noCalendar: false };
}

/**
 * Computes the availability of a DAY: business-hours grid classified against
 * the user's real calendar. Past slots become busy (reason "already past").
 */
export async function getDayAvailability(input: {
  userId: string;
  /** Local day (yyyy-mm-dd). */
  dateIso: string;
  /** User's IANA tz (e.g.: "America/Sao_Paulo"). */
  timeZone: string;
  /** "Now" instant to discard the past; default Date.now(). */
  now?: number;
}): Promise<AvailabilityDay> {
  const { userId, dateIso, timeZone } = input;
  const now = input.now ?? Date.now();

  const { busy, events, noCalendar } = await getBusyRangesForDay(
    userId,
    dateIso,
    timeZone,
  );

  const slots: Slot[] = [];
  for (let min = BUSINESS_START_MIN; min < BUSINESS_END_MIN; min += SLOT_STEP_MIN) {
    const slotStart = localWallToEpoch(dateIso, min, timeZone);
    const slotEnd = slotStart + SLOT_DURATION_MIN * 60000;
    const datetimeIso = `${dateIso}T${hm(min)}`;

    if (slotStart < now) {
      slots.push({ timeHm: hm(min), datetimeIso, busy: true, reason: "already past" });
      continue;
    }

    const conflict = events.find(
      (e) => e.range.end > slotStart && e.range.start < slotEnd,
    );
    if (conflict || overlaps(slotStart, slotEnd, busy)) {
      slots.push({
        timeHm: hm(min),
        datetimeIso,
        busy: true,
        reason: conflict?.title ?? "busy",
      });
    } else {
      slots.push({ timeHm: hm(min), datetimeIso, busy: false });
    }
  }

  return { dateIso, timeZone, slots, noCalendar };
}
