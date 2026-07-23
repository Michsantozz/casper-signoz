import { NextResponse } from "next/server";
import { getDayAvailability } from "@/server/recall/availability";
import { getSession } from "@/features/auth/model/session";
import { serverError } from "@/shared/lib/api-error";
import { DEFAULT_TIME_ZONE } from "@/shared/lib/config";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";

/**
 * Availability for a single DAY for the authenticated user — the business-hours
 * grid already classified (free/busy) against the real calendar.
 *
 * Consumed by PickDateToolUI (client): the UI can't import `server/`, so it
 * fetches here. Query: `date` (yyyy-mm-dd, required) and `tz` (IANA, optional —
 * defaults to America/Sao_Paulo).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Calls out to Recall (getDayAvailability) per request — throttle the caller.
  const rl = await checkRateLimit({
    key: `calendar-availability:${session.user.id}`,
    window: 60,
    max: 30,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const url = new URL(req.url);
  const dateIso = url.searchParams.get("date");
  const timeZone = url.searchParams.get("tz") || DEFAULT_TIME_ZONE;

  if (!dateIso || !DATE_RE.test(dateIso)) {
    return NextResponse.json(
      { error: "bad date", detail: "expected ?date=yyyy-mm-dd" },
      { status: 400 },
    );
  }
  // Validate the IANA tz early — an invalid tz would blow up inside Intl.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return NextResponse.json({ error: "bad timezone" }, { status: 400 });
  }

  try {
    const day = await getDayAvailability({
      userId: session.user.id,
      dateIso,
      timeZone,
    });
    return NextResponse.json(day);
  } catch (err) {
    return serverError("calendar-availability", err, "availability_failed", 502);
  }
}
