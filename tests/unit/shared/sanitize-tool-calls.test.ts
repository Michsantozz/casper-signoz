import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { sanitizeOrphanedToolCalls } from "@/shared/lib/sanitize-tool-calls";

/**
 * sanitizeOrphanedToolCalls — repairs frontend tool-calls that were left in a
 * non-terminal state (user navigated away mid-flow) so a reloaded thread
 * doesn't reopen stuck "running". Non-terminal → output-error; terminal states
 * and non-tool parts are untouched; unchanged messages keep their reference.
 */

const msg = (parts: unknown[]): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as unknown as UIMessage;

describe("sanitizeOrphanedToolCalls", () => {
  it("rewrites a dynamic-tool call stuck in input-available to output-error", () => {
    const out = sanitizeOrphanedToolCalls([
      msg([
        {
          type: "dynamic-tool",
          toolName: "connect_calendar",
          toolCallId: "t1",
          state: "input-available",
          input: {},
        },
      ]),
    ]);
    const part = out[0].parts[0] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
  });

  it("rewrites a typed tool-<name> part too (input-streaming)", () => {
    const out = sanitizeOrphanedToolCalls([
      msg([
        { type: "tool-pick_date", toolCallId: "t2", state: "input-streaming" },
      ]),
    ]);
    expect((out[0].parts[0] as { state: string }).state).toBe("output-error");
  });

  it("rewrites approval-requested / approval-responded", () => {
    for (const state of ["approval-requested", "approval-responded"]) {
      const out = sanitizeOrphanedToolCalls([
        msg([{ type: "dynamic-tool", toolCallId: "t", state, input: {} }]),
      ]);
      expect((out[0].parts[0] as { state: string }).state).toBe(
        "output-error",
      );
    }
  });

  it("leaves terminal tool states untouched", () => {
    for (const state of ["output-available", "output-error", "output-denied"]) {
      const input = [
        msg([{ type: "dynamic-tool", toolCallId: "t", state, output: {} }]),
      ];
      const out = sanitizeOrphanedToolCalls(input);
      // Unchanged message keeps its reference (no needless copy).
      expect(out[0]).toBe(input[0]);
      expect((out[0].parts[0] as { state: string }).state).toBe(state);
    }
  });

  it("ignores non-tool parts (text) and preserves the message reference", () => {
    const input = [msg([{ type: "text", text: "hi" }])];
    const out = sanitizeOrphanedToolCalls(input);
    expect(out[0]).toBe(input[0]);
  });

  it("only rewrites the orphaned part, leaving siblings intact", () => {
    const out = sanitizeOrphanedToolCalls([
      msg([
        { type: "text", text: "let me connect" },
        {
          type: "dynamic-tool",
          toolName: "connect_calendar",
          toolCallId: "t1",
          state: "input-available",
          input: {},
        },
        {
          type: "dynamic-tool",
          toolName: "get_free_slots",
          toolCallId: "t2",
          state: "output-available",
          output: { slots: [] },
        },
      ]),
    ]);
    const parts = out[0].parts as Array<{ type: string; state?: string }>;
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts[1].state).toBe("output-error");
    expect(parts[2].state).toBe("output-available"); // terminal, untouched
  });

  it("handles a message with no parts array gracefully", () => {
    const input = [{ id: "x", role: "assistant" } as unknown as UIMessage];
    expect(() => sanitizeOrphanedToolCalls(input)).not.toThrow();
    expect(sanitizeOrphanedToolCalls(input)[0]).toBe(input[0]);
  });
});
