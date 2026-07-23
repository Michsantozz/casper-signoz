import "server-only";
import { recallFetch } from "@/server/recall/client";
import { enqueueMeetingRecord } from "@/server/recall/meeting-repository";
import { findBotByBotId, resolveBotOwner } from "@/server/recall/bot-repository";
import { withSystemScope } from "@/shared/db/rls";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("poll-backfill");

/**
 * Poll-backfill against Recall (source of truth) — closes the "webhook never
 * arrived" blind spot.
 *
 * The reconcile cron only reprocesses rows that ALREADY exist in
 * meeting_records, and a row is only born when a `transcript.done` webhook
 * fires. If that webhook is lost (endpoint down during the delivery window,
 * Svix redelivery exhausted, secret rotated), no row is ever created and the
 * meeting is invisible forever — nothing detects it.
 *
 * This job asks Recall directly for recent bots and enqueues any that don't
 * yet have a meeting_record. enqueueMeetingRecord is idempotent
 * (onConflictDoNothing by botId), so re-enqueuing a bot that already has a row
 * is a harmless no-op — the webhook and this poll converge on the same row via
 * the natural key. The webhook stays the fast path (seconds); this is the slow
 * safety net (minutes).
 */

/** A bot as returned by Recall's list endpoint (only the fields we read). */
type RecallListBot = {
  id: string;
  // Present once the meeting is over; used to window the query.
  join_at?: string | null;
  status?: { code?: string } | null;
  status_changes?: Array<{ code?: string }>;
  metadata?: Record<string, unknown> | null;
  recordings?: Array<{
    media_shortcuts?: {
      transcript?: { status?: { code?: string } } | null;
    } | null;
  }>;
};

type RecallListPage = {
  results: RecallListBot[];
  next?: string | null;
};

/**
 * True if ANY of the bot's recordings has a transcript ready — the only bots
 * worth enqueuing (others aren't done yet; the webhook/reconcile handle them in
 * time). Scans the whole `recordings` array, not just [0], so a multi-recording
 * bot whose ready transcript isn't first still gets picked up.
 */
function hasReadyTranscript(bot: RecallListBot): boolean {
  return (bot.recordings ?? []).some(
    (r) => r?.media_shortcuts?.transcript?.status?.code === "done",
  );
}

/** Resolves the owner for a discovered bot: our mapping first, then metadata. */
async function resolveOwner(bot: RecallListBot) {
  return resolveBotOwner(await findBotByBotId(bot.id), bot.metadata?.user_id);
}

export type BackfillResult = {
  scanned: number;
  // Number of enqueue calls issued for ready-transcript bots. NOT the count of
  // newly-created rows: onConflictDoNothing makes an already-existing bot a
  // no-op, and it isn't distinguished here (would need the insert to RETURNING).
  enqueued: number;
  pages: number;
};

/**
 * Scans Recall bots joined within the last `windowMs` and enqueues any with a
 * ready transcript. Idempotent by construction (enqueue is onConflictDoNothing).
 *
 * `maxPages` bounds the work per run so a huge backlog can't run unboundedly;
 * the next cron tick continues from the same window (bots stay listed until
 * they age out of the window, and already-enqueued ones no-op).
 */
export async function backfillMissingMeetings(
  // 72h (was 24h): if the app is down longer than the window, a lost-webhook
  // meeting ages out before backfill ever sees it and is lost permanently. A
  // wider window survives a multi-day outage. Overridable via BACKFILL_WINDOW_MS.
  windowMs = Number(process.env.BACKFILL_WINDOW_MS) || 72 * 60 * 60_000,
  maxPages = Number(process.env.BACKFILL_MAX_PAGES) || 10,
): Promise<BackfillResult> {
  const joinedAfter = new Date(Date.now() - windowMs).toISOString();

  let scanned = 0;
  let enqueued = 0;
  let pages = 0;
  // Recall paginates with an opaque `next` cursor URL; we pass join_at_after on
  // the first request and follow `next` thereafter.
  let cursor: string | null = null;

  do {
    const page: RecallListPage = await recallFetch<RecallListPage>({
      method: "GET",
      path: "v1/bot/",
      query: cursor
        ? { cursor }
        : { join_at_after: joinedAfter, ordering: "-join_at" },
    });
    pages++;

    const ready = page.results.filter(hasReadyTranscript);
    scanned += page.results.length;

    for (const bot of ready) {
      const owner = await resolveOwner(bot);
      if (owner.conflict) {
        log.error(
          { botId: bot.id },
          "bot owner mismatch between persisted mapping and provider metadata; backfill skipped",
        );
        continue;
      }
      const userId = owner.userId;
      if (!userId) {
        // Ownerless bot discovered by the poll — enqueue anyway (data isn't
        // lost, RLS hides it until re-owned), but surface it like the webhook's
        // orphan guard so it's diagnosable.
        log.warn(
          { botId: bot.id },
          "orphan bot: transcript ready but no owner (no recall_bots row, no metadata.user_id)",
        );
      }
      // onConflictDoNothing → no-op if the webhook already created the row.
      await withSystemScope(() =>
        enqueueMeetingRecord({ botId: bot.id, userId }),
      );
      enqueued++;
    }

    // Recall's `next` is a full URL; extract just the cursor param for the next
    // call (recallFetch builds the URL itself).
    cursor = extractCursor(page.next);
  } while (cursor && pages < maxPages);

  // maxPages hit but Recall still has more pages → we stopped early and some
  // ready-transcript bots in the window may not have been scanned this run. Log
  // it instead of silently under-covering (the next tick resumes the window).
  if (cursor && pages >= maxPages) {
    log.warn(
      { maxPages, scanned },
      "hit maxPages with more pages remaining; backlog continues next tick",
    );
  }

  return { scanned, enqueued, pages };
}

/** Pulls the `cursor` query param out of Recall's `next` page URL. */
function extractCursor(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return null;
  }
}
