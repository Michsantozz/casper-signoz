"use server";

import { requireUserId } from "@/features/auth/model/session";
import { assertBotOwner } from "@/server/recall/ownership";
import {
  requeueMeetingRecord,
  enableMeetingShare,
  disableMeetingShare,
  deleteMeetingRecord,
  updateMeetingRecord,
  findMeetingRecord,
} from "@/server/recall/meeting-repository";
import { enrichMeeting } from "@/server/recall/enrich";
import {
  findBotByBotId,
  getOrCreateBotMapping,
  deleteBotMapping,
  defaultDedupKey,
} from "@/server/recall/bot-repository";
import { deleteObjectByUrl } from "@/server/storage/s3";
import { recallFetch, RecallAdhocPoolError } from "@/server/recall/client";
import {
  generateBehaviorInsight,
  type BehaviorInsight,
  type BehaviorMomentInput,
  type BehaviorMetricsInput,
} from "@/server/recall/behavior-insight";
import {
  generateScreenInsight,
  type ScreenInsight,
  type ScreenFrameInput,
} from "@/server/recall/screen-insight";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { withUserScope } from "@/shared/db/rls";

/**
 * Recovery actions for the meetings list — the domain's write bridge (Server
 * Actions per the architecture: client UI calls these, they touch server/*).
 * Both re-derive the userId from the session and assert bot ownership before
 * acting, so a client can never recover/cancel another tenant's meeting.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Re-runs enrichment for a FAILED meeting: requeues the record (pending) and
 * kicks the durable worker again. Ownership-checked. Used by the "reprocess"
 * button on a failed row.
 */
export async function reprocessMeeting(botId: string): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  // Requeue under the caller's scope (meeting_records is RLS-scoped), then let
  // the worker regenerate the minutes (it opens its own system scope per step).
  await withUserScope(userId, () =>
    requeueMeetingRecord(botId, "manual reprocess"),
  );
  const res = await enrichMeeting(botId);
  if (res.state === "failed") return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * Cancels a SCHEDULED bot before it joins: DELETEs it on Recall and clears the
 * local dedup mapping. Ownership-checked. Used by the "cancel" button on a
 * scheduled row.
 */
export async function cancelScheduledMeeting(
  botId: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  const bot = await findBotByBotId(botId);
  try {
    await recallFetch({ method: "DELETE", path: `v1/bot/${botId}/` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, error: `could not cancel: ${message}` };
  }
  // Clear the mapping so it stops showing as scheduled (best-effort).
  if (bot?.dedupKey) await deleteBotMapping(bot.dedupKey);
  return { ok: true };
}

/** Result of sending a bot: the botId + whether it was scheduled or ad-hoc. */
export type ScheduleResult =
  | { ok: true; botId: string; scheduled: boolean; reused: boolean }
  | { ok: false; error: string };

/**
 * Sends a Recall bot to a meeting URL from the UI — the direct (non-chat) path
 * behind the "new meeting" dialog. Owner = the session user (never trusted from
 * the client). Pass `joinAt` (ISO, >10min future) to schedule with a guaranteed
 * join, or omit it to join now (ad-hoc). Deduplicates per tenant: a second send
 * for the same meeting reuses the existing bot instead of double-booking.
 *
 * Mirrors scheduleRecallBotTool (the chat tool) so both entry points behave
 * identically; the recording config is Recall's hands-off default (records on
 * participant join, streaming transcript).
 */
export async function scheduleMeetingBot(input: {
  meetingUrl: string;
  joinAt?: string | null;
}): Promise<ScheduleResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }

  const meetingUrl = input.meetingUrl.trim();
  if (!meetingUrl) return { ok: false, error: "meeting URL required" };
  try {
    // Validate shape early so a typo doesn't reach Recall as a 400.
    new URL(meetingUrl);
  } catch {
    return { ok: false, error: "invalid meeting URL" };
  }

  const joinAt = input.joinAt?.trim() || undefined;
  // Reject a join time in the past (Recall requires >10min in the future to
  // guarantee a scheduled join; anything past is a mistake).
  if (joinAt) {
    const at = new Date(joinAt);
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: "invalid join time" };
    }
    if (at.getTime() <= Date.now()) {
      return { ok: false, error: "join time must be in the future" };
    }
  }

  const dedupKey = defaultDedupKey(userId, meetingUrl, joinAt);
  let result: Awaited<ReturnType<typeof getOrCreateBotMapping>>;
  try {
    result = await getOrCreateBotMapping({
      dedupKey,
      meetingUrl,
      joinAt: joinAt ? new Date(joinAt) : null,
      metadata: { user_id: userId },
      createBot: () =>
        recallFetch<{ id: string }>({
          method: "POST",
          path: "v1/bot/",
          body: {
            meeting_url: meetingUrl,
            ...(joinAt ? { join_at: joinAt } : {}),
            recording_config: {
              transcript: { provider: { recallai_streaming: {} } },
              participant_events: {},
              start_recording_on: "participant_join",
            },
            metadata: { dedup_key: dedupKey, user_id: userId },
          },
        }),
    });
  } catch (err) {
    if (err instanceof RecallAdhocPoolError) {
      return {
        ok: false,
        error:
          "Ad-hoc bot pool exhausted. Try again in ~30s, or schedule >10min ahead.",
      };
    }
    const message = err instanceof Error ? err.message : "could not send bot";
    return { ok: false, error: message };
  }

  return {
    ok: true,
    botId: result.row.botId,
    scheduled: result.row.joinAt != null,
    reused: !result.created,
  };
}

/**
 * Permanently deletes a meeting: removes the meeting_records row (RLS-scoped),
 * reclaims the durable video from object storage, and best-effort clears the
 * bot's local dedup mapping. Ownership-checked, so a client can never delete
 * another tenant's meeting. Used by the "delete" control on the list row and
 * the notebook header.
 *
 * Best-effort on side effects: a failed storage/mapping cleanup does NOT undo
 * the record delete (the row is the source of truth; an orphaned object or a
 * stale mapping is harmless and cheap to leave).
 */
export async function deleteMeeting(botId: string): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  // Delete the record under the caller's scope; the returned row carries the
  // durable video URL so we can reclaim its storage after.
  const deleted = await withUserScope(userId, () => deleteMeetingRecord(botId));

  // Reclaim the durable video (best-effort; foreign/Recall URLs are ignored).
  if (deleted?.videoUrl) await deleteObjectByUrl(deleted.videoUrl);

  // Clear the local dedup mapping so a re-scheduled bot for the same meeting
  // isn't deduped against a bot the user just deleted (best-effort).
  const bot = await findBotByBotId(botId);
  if (bot?.dedupKey) await deleteBotMapping(bot.dedupKey);

  return { ok: true };
}

/* ── owner edits (correcting the LLM output) ──────────────────────────── */

/** A hand-edited action item. `owner` is optional (unassigned = null). */
export type ActionItemEdit = { task: string; owner: string | null };

/**
 * Sets the meeting's owner-editable display title. Empty clears it (falls back
 * to the auto-derived label). Ownership-checked + RLS-scoped.
 */
export async function updateMeetingTitle(
  botId: string,
  title: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  const updated = await withUserScope(userId, () =>
    updateMeetingRecord(botId, { title: title.trim() || null }),
  );
  if (!updated) return { ok: false, error: "not found or not accessible" };
  return { ok: true };
}

/**
 * Overwrites the meeting's summary + overview with the owner's edit. Empty
 * strings clear the field (stored as null). Ownership-checked + RLS-scoped.
 * Used by the inline edit on the notebook's summary panel.
 */
export async function updateMeetingSummary(
  botId: string,
  summary: string,
  overview: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  const updated = await withUserScope(userId, () =>
    updateMeetingRecord(botId, {
      summary: summary.trim() || null,
      overview: overview.trim() || null,
    }),
  );
  if (!updated) return { ok: false, error: "not found or not accessible" };
  return { ok: true };
}

/**
 * Replaces the meeting's action-item list with the owner's edited set (add,
 * edit, remove, (re)assign owners). Blank tasks are dropped; owners are trimmed
 * to null when empty. Ownership-checked + RLS-scoped.
 */
export async function updateMeetingActionItems(
  botId: string,
  items: ActionItemEdit[],
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  const cleaned = items
    .map((i) => ({ task: i.task.trim(), owner: i.owner?.trim() || null }))
    .filter((i) => i.task.length > 0);

  const updated = await withUserScope(userId, () =>
    updateMeetingRecord(botId, { actionItems: cleaned }),
  );
  if (!updated) return { ok: false, error: "not found or not accessible" };
  return { ok: true };
}

/**
 * Renames a speaker across the whole meeting: the word-level transcript, the
 * talk-share list, and the team-dynamics participants. Done server-side so the
 * client never has to round-trip the full transcript — it just passes the old
 * and new labels. No-op (still ok) if the old name doesn't appear. Ownership-
 * checked + RLS-scoped.
 */
export async function renameMeetingSpeaker(
  botId: string,
  from: string,
  to: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }
  const next = to.trim();
  if (!next) return { ok: false, error: "name required" };

  return withUserScope(userId, async () => {
    const record = await findMeetingRecord(botId);
    if (!record) return { ok: false, error: "not found or not accessible" };

    // Rewrite the label everywhere it's persisted. Each field is null for
    // legacy rows / meetings without timestamps — left untouched when absent.
    const transcriptStruct = record.transcriptStruct?.map((u) =>
      u.speaker === from ? { ...u, speaker: next } : u,
    );
    const talkShares = record.talkShares?.map((s) =>
      s.name === from ? { ...s, name: next } : s,
    );
    const dynamics = record.dynamics
      ? {
          ...record.dynamics,
          participants: record.dynamics.participants.map((p) =>
            p.name === from ? { ...p, name: next } : p,
          ),
        }
      : record.dynamics;

    const updated = await updateMeetingRecord(botId, {
      ...(transcriptStruct ? { transcriptStruct } : {}),
      ...(talkShares ? { talkShares } : {}),
      ...(dynamics ? { dynamics } : {}),
    });
    if (!updated) return { ok: false, error: "not found or not accessible" };
    return { ok: true };
  });
}

/** Result of a share toggle: the token (null once revoked) so the UI builds the link. */
export type ShareResult =
  | { ok: true; shareToken: string | null }
  | { ok: false; error: string };

/**
 * Enables or revokes the meeting's public share link. Ownership-checked and
 * RLS-scoped, so a client can never share/unshare another tenant's meeting.
 * Used by the Share control in the notebook header.
 */
export async function setMeetingShare(
  botId: string,
  enabled: boolean,
): Promise<ShareResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  if (!enabled) {
    await withUserScope(userId, () => disableMeetingShare(botId));
    return { ok: true, shareToken: null };
  }
  const state = await withUserScope(userId, () => enableMeetingShare(botId));
  if (!state) return { ok: false, error: "not found or not accessible" };
  return { ok: true, shareToken: state.shareToken };
}

/** Result of a behavioral-insight run: the LLM read (null when nothing tense). */
export type BehaviorResult =
  | { ok: true; insight: BehaviorInsight | null }
  | { ok: false; error: string };

/**
 * Reads the human behavior behind the client-computed acoustic tension moments.
 * The client passes the already-fused per-moment scores + dynamics metrics (no
 * audio/video bytes) and the LLM interprets them. Ownership-checked so a client
 * can never run analysis against another tenant's meeting. Best-effort: a null
 * insight (flat meeting or LLM failure) is still `ok`. Used by the notebook's
 * "analyze tension" flow.
 */
export async function analyzeMeetingBehavior(
  botId: string,
  moments: BehaviorMomentInput[],
  metrics: BehaviorMetricsInput,
): Promise<BehaviorResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  try {
    const insight = await generateBehaviorInsight(moments, metrics);
    return { ok: true, insight };
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return { ok: false, error: message };
  }
}

/** One captured frame the client uploaded, ready for vision analysis. */
export type ScreenFrameArg = {
  url: string;
  atSeconds: number;
  trigger: ScreenFrameInput["trigger"];
};

/** Result of a screen-analysis run: the vision insight (null when unreadable). */
export type ScreenResult =
  | { ok: true; insight: ScreenInsight | null }
  | { ok: false; error: string };

/** Seconds of transcript on each side of a frame to give the vision model. */
const SCREEN_EXCERPT_WINDOW = 15;

/**
 * Reads the content of shared-screen frames with the vision model. The client
 * captures + uploads frames in-browser (mediabunny → /api/upload) and passes
 * their URLs here; this fetches the meeting's transcript under the caller's scope
 * to build a grounding excerpt per frame, then runs vision. Ownership-checked so
 * a client can never analyze another tenant's meeting. Best-effort: a null
 * insight (unreadable frames / model failure) is still `ok`. Used by the
 * notebook's "analyze screens" flow.
 */
export async function analyzeMeetingScreens(
  botId: string,
  frames: ScreenFrameArg[],
): Promise<ScreenResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }
  if (frames.length === 0) return { ok: true, insight: null };

  try {
    // Transcript read under the caller's scope (meeting_records is RLS-scoped),
    // to build a grounding excerpt around each frame's moment.
    const detail = await withUserScope(userId, () => getMeetingDetail(botId));
    const lines = detail.transcript
      .map((u) => ({
        start: u.words.find((w) => w.start != null)?.start ?? null,
        text: `${u.speaker}: ${u.words.map((w) => w.text).join(" ")}`.trim(),
      }))
      .filter((l): l is { start: number; text: string } => l.start != null);

    const excerptAround = (at: number): string =>
      lines
        .filter(
          (l) => l.start >= at - SCREEN_EXCERPT_WINDOW && l.start <= at + SCREEN_EXCERPT_WINDOW,
        )
        .map((l) => l.text)
        .join("\n");

    const frameInputs: ScreenFrameInput[] = frames.map((f) => ({
      url: f.url,
      atSeconds: f.atSeconds,
      trigger: f.trigger,
      excerpt: excerptAround(f.atSeconds),
    }));

    const insight = await generateScreenInsight(frameInputs);
    return { ok: true, insight };
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return { ok: false, error: message };
  }
}

/** Ownership check that never throws (returns false on any denial). */
async function isOwner(botId: string, userId: string): Promise<boolean> {
  try {
    await assertBotOwner(botId, userId);
    return true;
  } catch {
    return false;
  }
}
