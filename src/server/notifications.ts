import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/db";
import { notifications, type NotificationRow } from "@/shared/db/schema";

/**
 * In-app notifications.
 *
 * Created when a meeting's minutes are generated automatically after the call
 * ends (bot webhook). No external transport (email) for now — just in-app,
 * read via the bell icon.
 */

export type NotificationType =
  // Meeting minutes generated automatically after the call ends (bot webhook).
  | "meeting_summary_ready"
  // Minutes could NOT be generated — transcript failed on Recall, or enrichment
  // exhausted its retries. Surfaced so a failed meeting isn't a silent dead-end.
  | "meeting_failed";

/** Creates a notification for a user. */
export async function createNotification(input: {
  userId: string;
  type: NotificationType;
  message: string;
  /** Optional deep link to open when the notification is clicked. */
  link?: string | null;
  /** Stable id makes retried delivery idempotent. */
  idempotencyKey?: string;
}): Promise<void> {
  await db
    .insert(notifications)
    .values({
      id: input.idempotencyKey ?? randomUUID(),
      userId: input.userId,
      type: input.type,
      message: input.message,
      link: input.link ?? null,
    })
    .onConflictDoNothing({ target: notifications.id });
}

/**
 * Creates the same notification for several users at once. Ignores an empty list.
 */
export async function createNotificationsForUsers(input: {
  userIds: string[];
  type: NotificationType;
  message: string;
}): Promise<void> {
  const unique = Array.from(new Set(input.userIds));
  if (unique.length === 0) return;

  await db.insert(notifications).values(
    unique.map((userId) => ({
      id: randomUUID(),
      userId,
      type: input.type,
      message: input.message,
    })),
  );
}

/** A user's notifications, most recent first. */
export async function listNotifications(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number },
): Promise<NotificationRow[]> {
  const where = opts?.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  return db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(opts?.limit ?? 50);
}

/**
 * Marks a notification as read. Restricted to the owner (userId) so a user
 * can't mark another user's notification.
 */
export async function markNotificationRead(
  notificationId: string,
  userId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    );
}

/** Marks all of a user's unread notifications as read. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
}
