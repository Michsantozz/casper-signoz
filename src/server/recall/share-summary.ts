import "server-only";
import { assertBotOwner } from "@/server/recall/ownership";
import { findMeetingRecord } from "@/server/recall/meeting-repository";
import { summarizeMeeting } from "@/server/recall/summarize";
import {
  emailMeetingSummaryToRecipient,
  userIdentityById,
  type SummaryEmailContent,
} from "@/server/email";
import { checkRateLimit } from "@/shared/lib/rate-limit";
import { withUserScope } from "@/shared/db/rls";

/**
 * Shares a meeting's minutes by email with an ARBITRARY recipient chosen by the
 * meeting owner (e.g. a manager who wasn't in the call).
 *
 * This is the server bridge behind the chat's "email this summary to X" flow.
 * Because the recipient is free-form (not restricted to participants), it is
 * hardened against abuse:
 *  1. ownership — the caller must OWN the meeting (assertBotOwner, fail-closed);
 *  2. rate limit — capped per user so the agent can't become a spam cannon;
 *  3. durable-first — reuses the persisted minutes (no extra LLM $), only
 *     summarizing on the fly when the row hasn't been enriched yet.
 *
 * The email itself names the sender (anti-phishing) — see emailMeetingSummaryToRecipient.
 */

/** Max summary-share emails a single user may send per hour. */
const SHARE_RATE_LIMIT = { window: 3600, max: 10 } as const;

export type ShareSummaryResult =
  | { ok: true; to: string; meetingTitle: string }
  | {
      ok: false;
      reason: "rate_limited" | "not_ready" | "no_summary";
      retryAfter?: number;
    };

/** Derives a human meeting label from the record (URL host/path), or a fallback. */
function meetingTitleFrom(meetingUrl: string | null | undefined): string {
  if (!meetingUrl) return "your meeting";
  try {
    const u = new URL(meetingUrl);
    // e.g. "meet.google.com/abc-defg-hij" — enough to disambiguate for the reader.
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return "your meeting";
  }
}

/**
 * Sends the meeting minutes to `to`. Assumes `userId` is already authenticated
 * (the route/tool resolves it from the session — never from client input).
 */
export async function shareMeetingSummary(input: {
  botId: string;
  userId: string;
  to: string;
  note?: string;
}): Promise<ShareSummaryResult> {
  const { botId, userId, to, note } = input;

  // (1) Ownership — throws if the caller doesn't own this meeting.
  await assertBotOwner(botId, userId);

  // (2) Rate limit (anti-spam): free-form recipient makes this abuse-prone.
  const rl = await checkRateLimit({
    key: `share_summary:${userId}`,
    window: SHARE_RATE_LIMIT.window,
    max: SHARE_RATE_LIMIT.max,
  });
  if (!rl.ok) {
    return { ok: false, reason: "rate_limited", retryAfter: rl.retryAfter };
  }

  // (3) Durable-first: reuse the persisted minutes; summarize on demand only if
  // the row hasn't been enriched yet. meeting_records is RLS-scoped.
  const record = await withUserScope(userId, () => findMeetingRecord(botId));

  let content: SummaryEmailContent | null = null;
  if (record?.summary) {
    content = {
      summary: record.summary,
      overview: record.overview,
      decisions: record.decisions,
      actionItems: record.actionItems,
      topics: record.topics,
    };
  } else {
    // No persisted summary — generate on the fly (costs an LLM call).
    const s = await summarizeMeeting(botId);
    if (s.state === "processing") return { ok: false, reason: "not_ready" };
    if (!s.summary) return { ok: false, reason: "no_summary" };
    content = {
      summary: s.summary,
      overview: s.overview,
      decisions: s.decisions,
      actionItems: s.actionItems,
      topics: s.topics,
    };
  }

  // (4) Sender identity for the "X shared this" line (anti-phishing).
  const sender = await userIdentityById(userId);
  const senderName = sender?.name?.trim() || sender?.email || "A CasperAgent user";
  const meetingTitle = meetingTitleFrom(record?.meetingUrl);

  await emailMeetingSummaryToRecipient({
    to,
    senderName,
    meetingTitle,
    content,
    note,
  });

  return { ok: true, to, meetingTitle };
}
