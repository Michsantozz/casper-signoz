import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { retrieveCalendar } from "@/server/recall/calendars";
import {
  findCalendarById,
  updateCalendarStatus,
} from "@/server/recall/calendar-repository";
import { autoScheduleForCalendar } from "@/server/recall/auto-schedule";
import { withSystemScope } from "@/shared/db/rls";
import { serverError } from "@/shared/lib/api-error";

/**
 * Recall webhook (Calendar V2, delivered via Svix).
 *
 * Two events:
 * - `calendar.update`      → status changed (e.g. disconnected). Re-fetch and persist.
 * - `calendar.sync_events` → events changed. Re-fetch events and (un)schedule bots.
 *
 * Security: we verify the Svix signature (svix-id/svix-timestamp/svix-signature)
 * with the endpoint's signing secret BEFORE trusting the body. `wh.verify` does
 * HMAC-SHA256 + timing-safe comparison + timestamp window (anti-replay, 5min),
 * exactly like `stripe.webhooks.constructEvent`. Verification requires the RAW
 * body (req.text()) — never req.json(), which re-serializes and breaks the signature.
 */

type CalendarUpdate = {
  event: "calendar.update";
  data: { calendar_id: string };
};
type CalendarSyncEvents = {
  event: "calendar.sync_events";
  data: { calendar_id: string; last_updated_ts: string };
};
type RecallWebhook = CalendarUpdate | CalendarSyncEvents;

export async function POST(req: Request) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-closed: without the secret there's no way to authenticate the origin.
    // Refuse instead of processing an untrusted body.
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 500 },
    );
  }

  const rawBody = await req.text();
  // Recall signs with the Standard-Webhooks header family (`webhook-*`), not the
  // legacy `svix-*` names — accept both, else every real delivery 401s with
  // "Missing required headers" despite a correct secret (see webhook-recall-bot).
  const headers = {
    "svix-id":
      req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? "",
    "svix-timestamp":
      req.headers.get("svix-timestamp") ??
      req.headers.get("webhook-timestamp") ??
      "",
    "svix-signature":
      req.headers.get("svix-signature") ??
      req.headers.get("webhook-signature") ??
      "",
  };

  let payload: RecallWebhook;
  try {
    payload = new Webhook(secret).verify(rawBody, headers) as RecallWebhook;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    throw err;
  }

  try {
    switch (payload.event) {
      case "calendar.update": {
        // Re-fetch to get the latest status and persist it. Tenant table →
        // system scope (the webhook acts on behalf of the calendar owner).
        const calendarId = payload.data.calendar_id;
        const mapping = await withSystemScope(() =>
          findCalendarById(calendarId),
        );
        if (mapping) {
          const calendar = await retrieveCalendar(calendarId);
          await withSystemScope(() =>
            updateCalendarStatus(calendarId, calendar.status),
          );
        }
        break;
      }

      case "calendar.sync_events": {
        // Events changed. If the calendar has auto-recording enabled (opt-in),
        // schedule bots on upcoming events that have a meeting_url. Without
        // opt-in, do nothing (we don't record a meeting without consent). Recall's
        // per-event dedup guarantees idempotency with the sweep cron.
        const calendarId = payload.data.calendar_id;
        const mapping = await withSystemScope(() =>
          findCalendarById(calendarId),
        );
        if (mapping && mapping.metadata?.auto_record === true) {
          await autoScheduleForCalendar({
            calendarId,
            userId: mapping.userId,
          });
        }
        break;
      }

      default:
        // Unknown event — ack so it doesn't get redelivered.
        break;
    }
  } catch (err) {
    // 5xx makes Svix redeliver. Full error logged server-side; the caller
    // (Recall/Svix) only needs the status, not our internal message.
    return serverError("webhook-recall", err, "webhook_processing_failed", 500);
  }

  return NextResponse.json({ ok: true });
}
