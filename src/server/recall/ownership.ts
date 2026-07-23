import "server-only";
import { findBotByBotId, botOwnerUserId } from "@/server/recall/bot-repository";
import { findMeetingRecord } from "@/server/recall/meeting-repository";
import { withUserScope } from "@/shared/db/rls";

/**
 * Central bot-ownership guard for by-botId reads.
 *
 * Every chat tool that takes a raw `botId` and hits Recall directly
 * (transcript, recording, participants, summary, bot state) bypasses the
 * meeting_records RLS table — so RLS alone does NOT stop a caller from passing
 * another tenant's botId. This resolver closes that gap: a tool resolves the
 * caller's session userId, then asserts the bot belongs to them BEFORE any
 * Recall fetch.
 *
 * Ownership is authoritative in two places, checked in order:
 *  1. meeting_records (RLS-scoped) — set when the transcript is enqueued by the
 *     bot webhook. Covers every RECORDED meeting, including calendar
 *     auto-scheduled bots that never call saveBotMapping.
 *  2. recall_bots.metadata.user_id — set by the schedule tool. Covers bots
 *     that are SCHEDULED but haven't recorded yet (no meeting_records row).
 *
 * Fail-closed: unknown userId or a bot owned by nobody/someone-else → not owner.
 */

/** True if `botId` belongs to `userId`. Never throws for a missing bot. */
export async function isBotOwner(
  botId: string,
  userId: string,
): Promise<boolean> {
  if (!botId || !userId) return false;

  // (1) Recorded meetings: RLS returns the row only if it belongs to userId.
  const record = await withUserScope(userId, () => findMeetingRecord(botId));
  if (record) return true;

  // (2) Scheduled-but-not-recorded: owner lives in recall_bots metadata.
  const bot = await findBotByBotId(botId);
  return botOwnerUserId(bot) === userId;
}

/**
 * Asserts the caller owns `botId`, or throws. The thrown message is safe to
 * surface to the model/user: it does NOT reveal whether the bot exists — an
 * unknown bot and someone else's bot are indistinguishable (no enumeration).
 */
export async function assertBotOwner(
  botId: string,
  userId: string,
): Promise<void> {
  if (!(await isBotOwner(botId, userId))) {
    throw new Error(
      `Meeting ${botId} not found or not accessible for this user.`,
    );
  }
}
