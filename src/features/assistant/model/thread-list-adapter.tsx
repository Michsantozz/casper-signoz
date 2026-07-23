"use client";

import { useMemo, type PropsWithChildren } from "react";
import {
  RuntimeAdapterProvider,
  useAuiState,
  type GenericThreadHistoryAdapter,
  type MessageFormatRepository,
  type RemoteThreadListAdapter,
  type ThreadHistoryAdapter,
} from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { sanitizeOrphanedToolCalls } from "@/shared/lib/sanitize-tool-calls";

/**
 * Bridges assistant-ui's remote thread list to our REST endpoints (`/api/threads`),
 * which are backed by the same Mastra memory the agent persists to. So the
 * sidebar's conversations ARE the agent's memory threads — one source of truth.
 *
 * Message persistence is handled server-side by `/api/chat` (Mastra saves each
 * turn to the thread), so the history adapter here is load-only: `append` is a
 * no-op. On thread switch, `load()` fetches that thread's history and
 * assistant-ui hydrates it into the runtime.
 */

type ThreadDTO = {
  id: string;
  title?: string;
  archived: boolean;
  updatedAt: string;
};

async function jsonOrThrow(res: Response) {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

/**
 * Per-thread history: loads the active thread's messages from our endpoint.
 * `useCloudThreadListAdapter` is the canonical shape we mirror — the
 * `unstable_Provider` wraps each active thread in a `RuntimeAdapterProvider`
 * carrying this `history`, which `useChatRuntime` reads from context.
 *
 * `withFormat` is REQUIRED by `useChatRuntime`: it hands us the AI SDK v6
 * format adapter and expects a repository of v6 UIMessages back — exactly what
 * `/api/threads/[id]/messages` returns (Mastra messages already converted via
 * `toAISdkMessages`). We wrap them as a linear branch (each message's parent is
 * the previous one).
 */
function useThreadHistoryAdapter(): ThreadHistoryAdapter {
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
      // The generic <TMessage> is resolved by useChatRuntime to the AI SDK v6
      // UIMessage (via aiSDKV6FormatAdapter). We produce v6 UIMessages, so we
      // build a concrete adapter and widen it to the generic contract.
      withFormat<TMessage>() {
        const adapter: GenericThreadHistoryAdapter<UIMessage> = {
          async load(): Promise<MessageFormatRepository<UIMessage>> {
            if (!remoteId) return { messages: [] };
            const { messages } = (await fetch(
              `/api/threads/${remoteId}/messages`,
            ).then(jsonOrThrow)) as { messages: UIMessage[] };

            // Repair orphaned frontend tool-calls (left non-terminal when the
            // user navigated away mid-flow) so the thread doesn't reopen stuck.
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
function ThreadProvider({ children }: PropsWithChildren) {
  const history = useThreadHistoryAdapter();
  const adapters = useMemo(() => ({ history }), [history]);
  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
}

/**
 * Builds the RemoteThreadListAdapter. Threads are created with the same id
 * assistant-ui assigns locally (`initialize(threadId)`), so local id === Mastra
 * thread id — no id remapping, and `remoteId` in the transport body is already
 * the Mastra thread id.
 */
export function createThreadListAdapter(): RemoteThreadListAdapter {
  return {
    async list() {
      const { threads } = (await fetch("/api/threads").then(jsonOrThrow)) as {
        threads: ThreadDTO[];
      };
      return {
        threads: threads.map((t) => ({
          remoteId: t.id,
          status: t.archived ? ("archived" as const) : ("regular" as const),
          title: t.title,
        })),
      };
    },

    async initialize(threadId) {
      const { thread } = (await fetch("/api/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: threadId }),
      }).then(jsonOrThrow)) as { thread: ThreadDTO };
      return { remoteId: thread.id, externalId: undefined };
    },

    async rename(remoteId, newTitle) {
      await fetch(`/api/threads/${remoteId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      }).then(jsonOrThrow);
    },

    async archive(remoteId) {
      await fetch(`/api/threads/${remoteId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }).then(jsonOrThrow);
    },

    async unarchive(remoteId) {
      await fetch(`/api/threads/${remoteId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }).then(jsonOrThrow);
    },

    async delete(remoteId) {
      await fetch(`/api/threads/${remoteId}`, { method: "DELETE" }).then(
        jsonOrThrow,
      );
    },

    async fetch(threadId) {
      const { threads } = (await fetch("/api/threads").then(jsonOrThrow)) as {
        threads: ThreadDTO[];
      };
      const t = threads.find((x) => x.id === threadId);
      return {
        remoteId: threadId,
        status: t?.archived ? "archived" : "regular",
        title: t?.title,
      };
    },

    // Titles the conversation from its opening turns. The endpoint generates
    // the title (one-shot LLM), persists it via renameThread, and returns it;
    // we stream that finished title back as the assistant-ui title text.
    // Returning an empty stream (no appendText) leaves the "New Chat" fallback,
    // which is what happens when the thread has no content yet (title === null).
    async generateTitle(remoteId) {
      const { createAssistantStream } = await import("assistant-stream");
      const { title } = (await fetch(`/api/threads/${remoteId}/title`, {
        method: "POST",
      }).then(jsonOrThrow)) as { title: string | null };
      return createAssistantStream((controller) => {
        if (title) controller.appendText(title);
      });
    },

    unstable_Provider: ThreadProvider,
  };
}
