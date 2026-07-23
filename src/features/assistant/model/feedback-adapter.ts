import type { FeedbackAdapter } from "@assistant-ui/react";

/**
 * Sends 👍/👎 on an assistant message to `/api/feedback`, which forwards it to
 * Mastra's observability feedback pipeline. `submit` is synchronous (void), so
 * this is fire-and-forget — the UI reflects the choice optimistically and we
 * don't block on the network.
 *
 * `threadId` is read lazily at submit time so the adapter can be created once.
 */
export function createFeedbackAdapter(
  getThreadId: () => string | undefined,
): FeedbackAdapter {
  return {
    submit({ message, type }) {
      void fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: message.id,
          threadId: getThreadId(),
          type,
        }),
      }).catch(() => {
        // Feedback is best-effort telemetry — never surface an error to the user.
      });
    },
  };
}
