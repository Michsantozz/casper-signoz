import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { findBotByBotId, resolveBotOwner } from "@/server/recall/bot-repository";
import { enqueueMeetingRecord } from "@/server/recall/meeting-repository";
import { withSystemScope } from "@/shared/db/rls";
import { inngest } from "@/inngest/client";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("webhook-recall-bot");

/**
 * Recall BOT webhook (status/artifact change, delivered via Svix) — channel
 * SEPARATE from the calendar webhook (webhook-recall.ts). Configured in the Recall
 * dashboard pointing to /api/webhooks/recall/bot.
 *
 * Goal: close the loop after the meeting. When the transcript is ready
 * (transcript.done), we auto-generate the MINUTES (summarizeMeeting) and create
 * an in-app notification for the bot owner — which shows up in the global bell
 * and links to the minutes. It's the equivalent of Fireflies' "push": the user
 * doesn't need to come back and ask for the summary.
 *
 * Security: same Svix verification as the calendar webhook (HMAC-SHA256 +
 * timing-safe + anti-replay window). Requires the RAW body (req.text()).
 */

type BotBase = {
  data: {
    bot?: { id?: string; metadata?: Record<string, unknown> };
    // Status artifact (transcript.failed etc.): machine-readable failure code.
    data?: { code?: string; sub_code?: string | null };
  };
};
type TranscriptDone = BotBase & { event: "transcript.done" };
type TranscriptFailed = BotBase & { event: "transcript.failed" };
type BotDone = BotBase & { event: "bot.done" };
type BotWebhook =
  | TranscriptDone
  | TranscriptFailed
  | BotDone
  | { event: string; data: unknown };

export async function POST(req: Request) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-closed: without a secret there's no way to authenticate the origin.
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }

  const rawBody = await req.text();

  // Recall signs with the Standard-Webhooks header family (`webhook-id`,
  // `webhook-timestamp`, `webhook-signature`), NOT the legacy `svix-*` names.
  // The svix verifier only reads whatever keys we hand it, so accept both:
  // without the `webhook-*` fallback every real delivery failed with "Missing
  // required headers" → 401, even though the signing secret was correct.
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

  let payload: BotWebhook;
  try {
    payload = new Webhook(secret).verify(rawBody, headers) as BotWebhook;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    throw err;
  }

  try {
    // We react to two terminal transcript outcomes:
    //  - transcript.done   → the minutes can be generated (happy path);
    //  - transcript.failed → transcription itself failed on Recall (bad audio,
    //    ASR error). There will be NO transcript.done, so if we ignored this the
    //    meeting would leave no row at all and be invisible forever (a ghost).
    //    We record it as failed + notify the owner instead of staying silent.
    if (payload.event !== "transcript.done" && payload.event !== "transcript.failed") {
      return NextResponse.json({ ok: true, ignored: payload.event });
    }

    const data = payload.data as BotBase["data"];
    const botId = data.bot?.id;
    if (!botId) {
      return NextResponse.json({ ok: true, note: "no bot id" });
    }

    // Resolve the owner: payload metadata first, then the repo (persisted
    // at bot creation). We store it alongside the minutes for scope/notification.
    const payloadUser =
      typeof data.bot?.metadata?.user_id === "string"
        ? (data.bot.metadata.user_id as string)
        : null;
    const row = await findBotByBotId(botId);
    const owner = resolveBotOwner(row, payloadUser);
    if (owner.conflict) {
      log.error(
        { botId },
        "bot owner mismatch between persisted mapping and webhook metadata; event quarantined",
      );
      return NextResponse.json({ ok: true, botId, quarantined: "owner_mismatch" });
    }
    const userId = owner.userId;

    // Orphan guard: with no owner, RLS hides the resulting row from every user
    // and no one can be notified — the meeting would be processed and then
    // invisible. We still enqueue (so the data isn't lost and can be re-owned
    // later), but surface it loudly instead of silently.
    if (!userId) {
      log.warn(
        { botId },
        "orphan meeting: no owner resolved (no payload metadata.user_id and no recall_bots row); row hidden by RLS until an owner is attached",
      );
    }

    // Transcript failed on Recall's side → mark the meeting failed and tell the
    // owner. Record it as `failed` with the Recall sub_code so the failure is
    // visible in the list (not a ghost), and skip enrichment (there's nothing to
    // enrich). Idempotent: enqueue is a no-op if a row already exists, then we
    // fail it.
    if (payload.event === "transcript.failed") {
      const subCode = data.data?.sub_code ?? data.data?.code ?? "unknown";
      const reason = `transcript.failed: ${subCode}`;
      const { markMeetingTranscriptFailed } = await import(
        "@/server/recall/enrich"
      );
      await withSystemScope(() =>
        markMeetingTranscriptFailed({
          botId,
          userId,
          meetingUrl: row?.meetingUrl ?? null,
          reason,
        }),
      );
      return NextResponse.json({ ok: true, botId, recorded: "transcript_failed" });
    }

    // ENQUEUES the minutes (idempotent) instead of generating them synchronously
    // here. Generation lives in the durable meeting-enrich workflow — persisted to
    // meeting_records so we don't re-fetch from Recall (which expires) or re-pay
    // the LLM on every read.
    await withSystemScope(() =>
      enqueueMeetingRecord({
        botId,
        userId,
        meetingUrl: row?.meetingUrl ?? null,
      }),
    );

    // Hands enrichment to the durable meeting-enrich workflow (event-driven) and
    // returns immediately — the webhook never blocks on the LLM/media work. If the
    // send fails, we do NOT return 5xx: the row is already pending, so the reconcile
    // cron reprocesses it. `data.inputData` is the shape the Mastra workflow start
    // event expects (see @mastra/inngest). runId is generated server-side if absent.
    await inngest
      .send({ name: "workflow.meeting-enrich", data: { inputData: { botId } } })
      .catch(() => {
        // Swallowed on purpose: the reconcile cron is the safety net.
      });

    return NextResponse.json({ ok: true, botId, dispatched: "meeting-enrich" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // 5xx makes Svix redeliver (useful if the enqueue fails transiently).
    return NextResponse.json(
      { error: "bot webhook processing failed", detail: message },
      { status: 500 },
    );
  }
}
