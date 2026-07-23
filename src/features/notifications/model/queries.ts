"use client";

/**
 * TanStack Query layer for in-app notifications.
 *
 * The backend (GET /api/notifications, POST /api/notifications/:id/read) already
 * exists; this file holds the query key, the type, and the hooks that the
 * global bell (NotificationBell) consumes. Its own slice so the AppShell (auth
 * feature) can render the bell without crossing the boundary — notifications is
 * cross-cutting to the product.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Notification {
  id: string;
  type: string;
  message: string;
  /** Deep link to open when clicked (e.g. /meetings/[botId]); null = index. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

// Slice's own key, isolated so our polling/refetch options don't leak into
// any other notifications query.
const notificationsKey = ["notifications", "bell"] as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Lists the authenticated user's notifications. Does light polling (30s) so
 * the bell reflects ready minutes without a reload.
 * `enabled=false` (e.g. logged out) disables the query and the polling.
 */
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => getJson<NotificationsResponse>("/api/notifications"),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

/** Marks a notification as read and revalidates the list/counter. */
export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`read → ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: notificationsKey });
    },
  });
}
