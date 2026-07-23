"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
  useAuiState,
} from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { shouldResumeAfterClientTool } from "@/features/assistant/model/resume-predicate";
import { PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { GoogleCalendarIcon } from "@/shared/ui/google-calendar-icon";
import { Thread } from "@/shared/ui/assistant-ui/thread";
import { ThreadList } from "@/shared/ui/assistant-ui/thread-list";
import { cn } from "@/shared/lib/utils";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { PickDateTool } from "@/features/meetings/ui/PickDateToolUI";
import { ConnectCalendarTool } from "@/features/meetings/ui/CalendarConnectToolUI";
import { SendSummaryEmailTool } from "@/features/meetings/ui/SendSummaryEmailToolUI";
import { createThreadListAdapter } from "@/features/assistant/model/thread-list-adapter";
import { createUploadAttachmentAdapter } from "@/features/assistant/model/attachment-adapter";
import { createFeedbackAdapter } from "@/features/assistant/model/feedback-adapter";

/**
 * Runtime for a single active thread. Wrapped by `useRemoteThreadListRuntime`,
 * which renders this once per active thread INSIDE the thread-list-item context
 * — so the transport can read the active thread's `id` (= the Mastra thread id,
 * since local id === remote id).
 *
 * The transport injects `threadId` into the /api/chat body so Mastra binds
 * memory to that thread (persist + recall). `resource` is NOT sent from the
 * client — the route derives it from the session (a client-supplied resource
 * would let a caller read another user's thread).
 */
function useChatThreadRuntime() {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async ({ id, messages, body }) => ({
          // `id` is the active thread's remoteId (assistant-ui fills it in when
          // wrapped by the remote thread list). Re-include id/messages: when we
          // return a `body`, it fully replaces the transport's default body.
          body: { ...body, id, messages, threadId: id },
        }),
      }),
    [],
  );

  // Attachment adapter: uploads images/PDFs to object storage (MinIO/S3 via
  // /api/upload) and emits an image/file part the vision model reads. Stable
  // for the runtime's lifetime — it only closes over fetch.
  const attachments = useMemo(() => createUploadAttachmentAdapter(), []);

  // Active thread id (= Mastra thread id) for correlating feedback. Read via
  // useAuiState because this hook runs inside the thread-list-item context.
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const feedback = useMemo(
    () => createFeedbackAdapter(() => remoteId),
    [remoteId],
  );

  return useChatRuntime({
    transport,
    adapters: { attachments, feedback },
    // After a CLIENT tool returns its result, automatically resend to the agent
    // so it continues the flow. Scoped to client tools only — the stock
    // predicate also fired on the agent's server tools and looped the turn.
    sendAutomaticallyWhen: shouldResumeAfterClientTool,
  });
}

/**
 * The unified assistant chat. Merges what used to be split across `/` and
 * `/meetings`:
 * - ThreadList sidebar (multi-conversation history, persisted memory per thread)
 * - Calendar top bar (connected · email / connect / disconnect), always visible
 * - Meeting tool UIs + pick_date + connect_calendar (assistantAgent)
 *
 * Single agent (assistantAgent, /api/chat). It's the app's home chat.
 */
export function Assistant() {
  // Adapter is stable for the component's lifetime — it only closes over fetch.
  const adapter = useMemo(() => createThreadListAdapter(), []);
  const runtime = useRemoteThreadListRuntime({
    adapter,
    runtimeHook: useChatThreadRuntime,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* ToolUIs registered on the provider — render the agent's tool-calls.
          Meetings + connected calendar (Recall/Calendar). Without registration,
          list_calendar_events / summarize_meeting / etc. fall back to raw JSON. */}
      <MeetingToolUIs />
      {/* Clickable calendar in the chat — user picks the day, agent continues. */}
      <PickDateTool />
      {/* Connect Google Calendar via chat (button → OAuth popup → polling). */}
      <ConnectCalendarTool />
      {/* Confirm + send a meeting's minutes by email (button → POST). */}
      <SendSummaryEmailTool />

      {/* Two-pane layout: conversation sidebar (left) + active thread (right).
          Sits to the right of the app's fixed nav rail (page adds md:pl-14). */}
      <div className="flex h-dvh">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-background p-2 md:flex">
          <ThreadList />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <CalendarBar />
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

/* ── calendar top bar (merged from the old MeetingAssistant) ───────── */

type CalendarStatus = {
  connected: boolean;
  count: number;
  calendars: Array<{
    id: string;
    platform: string;
    email: string | null;
    status: string | null;
  }>;
};

/** Always-visible calendar status/control bar at the top of the chat. */
function CalendarBar() {
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/status");
      if (res.ok) setCalendar(await res.json());
    } catch {
      /* keep previous state */
    }
  }, []);

  useEffect(() => {
    // Initial calendar status fetch (fetch → async setState). Mount-time I/O,
    // not state derivable at render time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    // ?connected=1 comes back from calendar OAuth — clear the query, refetch,
    // and confirm with a toast (the OAuth redirect gives no other feedback).
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) {
      window.history.replaceState({}, "", "/");
      refreshStatus();
      toast.success("Calendar connected", {
        description: "Your Google Calendar is linked. You're still signed in.",
      });
    }
  }, [refreshStatus]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/calendar/disconnect", { method: "POST" });
      if (res.ok) {
        // Make it explicit this only unlinks the calendar — the app session is
        // untouched, so the user does NOT get signed out.
        toast.success("Calendar disconnected", {
          description: "Only the calendar was unlinked — you're still signed in.",
        });
      } else {
        toast.error("Couldn't disconnect the calendar", {
          description: "Please try again.",
        });
      }
      await refreshStatus();
    } catch {
      toast.error("Couldn't disconnect the calendar", {
        description: "Please try again.",
      });
    } finally {
      setDisconnecting(false);
    }
  }, [refreshStatus]);

  const connected = calendar?.connected ?? false;
  const primaryEmail = calendar?.calendars[0]?.email ?? null;

  return (
    <header className="flex items-center justify-between gap-2 border-b bg-background px-4 py-2 pl-14 md:pl-4">
      {/* namespace eyebrow — matches the terminal header pattern */}
      <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            connected
              ? "bg-emerald-500 shadow-[0_0_0_3px_theme(colors.emerald.500/0.15)]"
              : "animate-pulse bg-muted-foreground/50",
          )}
        />
        calendar
      </span>

      <div className="flex items-center gap-2">
        {connected ? (
          <>
            <span className="flex items-center gap-2 rounded-full border border-border bg-muted/40 py-1 pl-1.5 pr-3 text-[12px] shadow-sm">
              {/* Official Google Calendar mark, tucked in a white chip so the
                  multicolor logo stays legible on any header background. */}
              <span className="flex size-6 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5">
                <GoogleCalendarIcon size={15} aria-label="Google Calendar" />
              </span>
              <span className="flex items-center gap-1.5 leading-none">
                <span className="font-medium text-foreground">Connected</span>
                {primaryEmail ? (
                  <span className="max-w-[220px] truncate text-muted-foreground">
                    · {primaryEmail}
                  </span>
                ) : null}
                {calendar && calendar.count > 1 ? (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    +{calendar.count - 1}
                  </span>
                ) : null}
              </span>
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={disconnecting}
              aria-label="Disconnect calendar"
              className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
            >
              <XIcon className="size-3.5" />
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.location.href = "/api/calendar/google/start";
            }}
            className="flex items-center gap-2 rounded-full border border-border bg-background py-1 pl-1.5 pr-3.5 text-[12px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted/50"
          >
            {/* White chip keeps the brand logo readable on the button. */}
            <span className="flex size-6 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5">
              <GoogleCalendarIcon size={15} aria-label="Google Calendar" />
            </span>
            <span className="flex items-center gap-1 leading-none">
              <PlusIcon className="size-3.5 text-muted-foreground" />
              Connect calendar
            </span>
          </button>
        )}
      </div>
    </header>
  );
}
