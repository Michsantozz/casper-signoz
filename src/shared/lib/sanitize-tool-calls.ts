import type { UIMessage } from "ai";

/**
 * Repairs orphaned tool-calls in a persisted message history before it hydrates
 * into an assistant-ui runtime.
 *
 * A FRONTEND tool call (client-fulfilled, no server `execute`) that never
 * received its result — because the user left mid-flow, cancelled, or the tab
 * closed — persists with a NON-TERMINAL state (`input-streaming` /
 * `input-available` / `approval-*`). On reload, assistant-ui faithfully
 * reconstructs that state and the thread reopens stuck "running" forever: the
 * in-memory resolver Map is gone, so nothing can ever complete the call.
 *
 * We rewrite those parts to a terminal `output-error` so the history loads as a
 * finished (if interrupted) turn. This is purely a client-side load-time repair
 * of already-broken data — the underlying persisted record is untouched; new
 * turns simply start from a clean, non-hanging state.
 *
 * Terminal states are left as-is: `output-available`, `output-error`,
 * `output-denied`.
 */

const NON_TERMINAL_TOOL_STATES = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

const INTERRUPTED = "Tool call interrupted (not completed before reload).";

function isToolPart(part: { type?: string }): boolean {
  return (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  );
}

/**
 * Returns a new message list with any non-terminal tool-call parts rewritten to
 * `output-error`. Messages/parts without orphaned tool calls are returned by
 * reference (no needless copies).
 */
export function sanitizeOrphanedToolCalls(
  messages: readonly UIMessage[],
): UIMessage[] {
  return messages.map((message) => {
    const parts = message.parts;
    if (!Array.isArray(parts)) return message;

    let changed = false;
    const nextParts = parts.map((part) => {
      const p = part as { type?: string; state?: string };
      if (isToolPart(p) && p.state && NON_TERMINAL_TOOL_STATES.has(p.state)) {
        changed = true;
        return { ...part, state: "output-error", errorText: INTERRUPTED };
      }
      return part;
    });

    return changed
      ? ({ ...message, parts: nextParts } as UIMessage)
      : message;
  });
}
