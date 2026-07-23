"use client";

/**
 * Meeting notebook page shell (client): notebook à esquerda | Thread real do
 * assistant à direita, painéis redimensionáveis (AssistantSidebar).
 *
 * The right pane talks to the MEETING SPECIALIST directly: `/api/chat` with
 * `agentId: "minutesAgent"` and the meeting's botId pinned in the body. So the
 * user converses with the agent that OWNS this meeting (summary, decisions,
 * action items, participants, transcript, dynamics) without the supervisor's
 * delegation hop.
 *
 * The conversation PERSISTS: one Mastra thread per meeting (`meeting-<botId>`,
 * resourceId-scoped to the user). We mount it via `useRemoteThreadListRuntime`
 * with a SINGLE-THREAD adapter — the canonical assistant-ui way to bind a
 * useChatRuntime chat to a persisted thread:
 *  - `initialize` POSTs /api/threads so the thread EXISTS before the first turn
 *    (Mastra memory recall needs the row);
 *  - the active thread's `remoteId` is what makes assistant-ui's history loader
 *    (`useExternalHistory`) actually run on mount — without a thread-list-item
 *    remoteId it early-returns and NEVER hydrates. That's why a bare
 *    `useChatRuntime({ adapters: { history } })` here reopened empty/stale.
 * The history adapter (per-thread, injected via `unstable_Provider`) hydrates
 * that thread when the notebook reopens; the route binds memory so each turn is
 * saved.
 */

import { useEffect, useMemo, type PropsWithChildren } from "react";
import {
  AssistantRuntimeProvider,
  RuntimeAdapterProvider,
  useRemoteThreadListRuntime,
  useAuiState,
  type GenericThreadHistoryAdapter,
  type MessageFormatRepository,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import {
  useChatRuntime,
  AssistantChatTransport,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { UIMessage } from "ai";
import { sanitizeOrphanedToolCalls } from "@/shared/lib/sanitize-tool-calls";
import { AssistantSidebar } from "@/shared/ui/assistant-ui/assistant-sidebar";
import { MeetingToolUIs } from "@/features/meetings/ui/MeetingToolUI";
import { MeetingDetail } from "@/features/meetings/ui/MeetingDetail";

/** Stable Mastra thread id for a meeting's notebook conversation. Namespaced so
 *  it can't collide with the assistant sidebar's threads. local id === Mastra
 *  thread id, so no remapping. */
function meetingThreadId(botId: string): string {
  return `meeting-${botId}`;
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

/**
 * Per-thread history: loads the meeting thread's messages. `withFormat` is the
 * path `useChatRuntime` uses — it hands us the AI SDK v6 format and expects a
 * repository of v6 UIMessages back, exactly what /api/threads/[id]/messages
 * returns (Mastra messages already converted via toAISdkMessages). We wrap them
 * as a linear branch (each message's parent is the previous one). `append` is a
 * no-op: Mastra persists each turn server-side in /api/chat.
 *
 * Reads the active thread's `remoteId` from context (this runs inside the
 * thread-list-item provider), so it loads the RIGHT thread and only once a
 * remoteId exists — which is also the gate that makes the loader run at all.
 */
function useMeetingHistoryAdapter(): ThreadHistoryAdapter {
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);

  return useMemo<ThreadHistoryAdapter>(
    () => ({
      // Never called directly with useChatRuntime (withFormat path is used),
      // but the type requires it.
      async load() {
        return { messages: [] };
      },
      async append() {
        // No-op: Mastra persists messages server-side in /api/chat.
      },
      withFormat<TMessage>() {
        const adapter: GenericThreadHistoryAdapter<UIMessage> = {
          async load(): Promise<MessageFormatRepository<UIMessage>> {
            if (!remoteId) return { messages: [] };
            const { messages } = (await fetch(
              `/api/threads/${remoteId}/messages`,
            ).then(jsonOrThrow)) as { messages: UIMessage[] };

            // Repair orphaned frontend tool-calls (left non-terminal when the
            // user navigated away mid-flow) so the notebook doesn't reopen stuck.
            const repaired = sanitizeOrphanedToolCalls(messages);

            let parentId: string | null = null;
            const items = repaired.map((message) => {
              const item = { parentId, message };
              parentId = message.id;
              return item;
            });
            return { messages: items };
          },
          async append() {
            // No-op: server-side persistence.
          },
        };
        return adapter as unknown as GenericThreadHistoryAdapter<TMessage>;
      },
    }),
    [remoteId],
  );
}

/** Injects the per-thread history adapter into the active thread's runtime. */
function MeetingThreadProvider({ children }: PropsWithChildren) {
  const history = useMeetingHistoryAdapter();
  const adapters = useMemo(() => ({ history }), [history]);
  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
}

/**
 * Single-thread RemoteThreadListAdapter for one meeting. The notebook has no
 * thread SWITCHER — it's always the same `meeting-<botId>` thread — but going
 * through the remote-thread-list runtime is what (a) initializes the thread on
 * the server and (b) exposes the active `remoteId` the history loader needs.
 *
 * `list` returns exactly that one thread; `initialize` upserts it via POST
 * /api/threads (idempotent — createThread upserts). rename/archive/delete are
 * inert (the notebook never offers them) but must exist to satisfy the type.
 */
function createMeetingThreadListAdapter(
  threadId: string,
): RemoteThreadListAdapter {
  const one = { remoteId: threadId, status: "regular" as const, title: undefined };
  return {
    async list() {
      return { threads: [one] };
    },
    async initialize(id) {
      // Upsert the thread so Mastra memory recall has a row (idempotent).
      await fetch("/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }).then(jsonOrThrow);
      return { remoteId: id, externalId: undefined };
    },
    // The notebook is a single fixed thread — no rename/archive/delete UI, and
    // no title generation (the meeting already has a title). These are inert but
    // must exist to satisfy the RemoteThreadListAdapter type.
    async rename() {},
    async archive() {},
    async unarchive() {},
    async delete() {},
    async generateTitle() {
      const { createAssistantStream } = await import("assistant-stream");
      return createAssistantStream(() => {});
    },
    async fetch() {
      return one;
    },
    unstable_Provider: MeetingThreadProvider,
  };
}

/**
 * Builds the runtime hook for the meeting thread, closing over the fixed botId.
 * `useRemoteThreadListRuntime` treats `runtimeHook` as a component, so hooks
 * inside are called unconditionally at the top level. The botId is fixed for
 * the notebook's lifetime (it comes from the route; navigating to another
 * meeting remounts the whole page), so closing over the value — and recreating
 * the hook only if botId changes — is correct and keeps identity stable per
 * meeting.
 */
function makeUseMeetingRuntime(botId: string) {
  return function useMeetingRuntime() {
    const transport = useMemo(
      () =>
        new AssistantChatTransport({
          api: "/api/chat",
          // `id` is the active thread's remoteId (assistant-ui fills it in). We
          // pin agentId + meetingBotId so the turn goes to the meeting specialist
          // scoped to THIS meeting; threadId binds Mastra memory (persist/recall).
          prepareSendMessagesRequest: async ({ id, messages, body }) => ({
            body: {
              ...body,
              id,
              messages,
              threadId: id,
              agentId: "minutesAgent",
              meetingBotId: botId,
            },
          }),
        }),
      [],
    );

    return useChatRuntime({
      transport,
      // After a frontend tool returns its result, resend so the agent continues.
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    });
  };
}

export function MeetingNotebook({ botId }: { botId: string }) {
  const threadId = useMemo(() => meetingThreadId(botId), [botId]);
  const adapter = useMemo(
    () => createMeetingThreadListAdapter(threadId),
    [threadId],
  );
  const runtimeHook = useMemo(() => makeUseMeetingRuntime(botId), [botId]);

  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook });

  // Open the meeting's OWN persisted thread on mount. The remote thread list
  // otherwise opens a fresh, unselected thread — nothing is active, so the
  // history loader (which gates on the active thread's remoteId) never runs and
  // the conversation reopens empty. Wait for the list to load, then switch to
  // `meeting-<botId>`: that selects the thread-list-item, exposes its remoteId,
  // and triggers hydration. Idempotent and safe to run once per thread id.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await runtime.threads.getLoadThreadsPromise();
      if (cancelled) return;
      if (runtime.threads.getState().mainThreadId !== threadId) {
        await runtime.threads.switchToThread(threadId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime, threadId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Tool UIs do agente de reunião (cards no lugar do JSON cru). */}
      <MeetingToolUIs />
      <main className="h-dvh w-full bg-(--thread-frame-outer) font-sans text-foreground md:pl-14">
        <AssistantSidebar defaultSize={68} sidebarSize={32}>
          <MeetingDetail botId={botId} />
        </AssistantSidebar>
      </main>
    </AssistantRuntimeProvider>
  );
}
