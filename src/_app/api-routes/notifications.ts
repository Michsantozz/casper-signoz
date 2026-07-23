import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { listNotifications } from "@/server/notifications";

/**
 * In-app notifications for the authenticated user (the bell icon).
 * Query `?unread=1` filters to unread only.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const unreadOnly = new URL(req.url).searchParams.get("unread") === "1";
  const items = await listNotifications(session.user.id, { unreadOnly });

  return NextResponse.json({
    notifications: items.map((n) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      link: n.link,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    unreadCount: items.filter((n) => !n.readAt).length,
  });
}
