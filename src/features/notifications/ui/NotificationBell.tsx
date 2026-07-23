"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, CheckCheckIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useSession } from "@/features/auth/model/auth-client";
import {
  useNotifications,
  useMarkNotificationRead,
  type Notification,
} from "@/features/notifications/model/queries";

/**
 * Global notifications bell — self-contained overlay (position: fixed), in the
 * bottom-left corner, aligned with the AppShell rail. Rendered by app/layout.
 *
 * Why it's outside AppShell: AppShell lives in the `auth` slice, which by the
 * ESLint boundary can't import `notifications`. The bell is self-contained and
 * the app is what injects it — same pattern as OnboardingDialog.
 *
 * Clicking a notification (e.g. "minutes ready") marks it read and opens its
 * deep link (e.g. /meetings/[botId]), falling back to the /meetings index.
 */
export function NotificationBell() {
  const { data: session } = useSession();
  const enabled = !!session?.user;
  const { data } = useNotifications(enabled);
  const markRead = useMarkNotificationRead();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mount gate: the server never has a session (client-only auth), so it always
  // renders null. Rendering the bell before mount would diverge from the server
  // HTML and trip a hydration mismatch. Show it only after the client mounts.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  // Fecha ao clicar fora / Esc.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!mounted || !enabled) return null;

  const items = data?.notifications ?? [];
  const unread = data?.unreadCount ?? 0;

  function openNotification(n: Notification) {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    // Deep link straight to the meeting notebook when present; else the index.
    router.push(n.link ?? "/meetings");
  }

  return (
    <div className="fixed bottom-3 left-2 z-50 md:left-16" ref={panelRef}>
      {open && (
        <div className="absolute bottom-11 left-0 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col rounded-[10px] border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="font-mono text-xs text-muted-foreground">
              notifications
            </span>
            {unread > 0 && (
              <span className="font-mono text-[10px] text-(--thread-accent-primary)">
                {unread} unread
              </span>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
                <CheckCheckIcon className="size-5 text-muted-foreground/60" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  nothing here
                </span>
              </div>
            ) : (
              <ul className="flex flex-col">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => openNotification(n)}
                      className={cn(
                        "flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-muted",
                        !n.readAt && "bg-(--thread-accent-primary-soft)/40",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {!n.readAt && (
                          <span
                            aria-hidden
                            className="size-1.5 shrink-0 rounded-full bg-(--thread-accent-primary)"
                          />
                        )}
                        <span className="text-sm leading-snug text-foreground">
                          {n.message}
                        </span>
                      </span>
                      <span className="pl-0 font-mono text-[10px] text-muted-foreground">
                        {fmtWhen(n.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-[8px] border bg-background shadow-sm transition-colors",
          "text-muted-foreground hover:text-foreground",
          open && "text-foreground",
        )}
      >
        <BellIcon className="size-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-(--thread-accent-primary) px-1 font-mono text-[10px] font-semibold text-background">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}

/** Short relative time in English (e.g. "2 min ago", "3 h ago", "yesterday"). */
function fmtWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}
