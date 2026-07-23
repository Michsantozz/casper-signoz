import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFeedbackAdapter } from "@/features/assistant/model/feedback-adapter";
import type { ThreadMessage } from "@assistant-ui/react";

/**
 * Chat feedback adapter (features/assistant/model/feedback-adapter.ts).
 * Bridges the ActionBar 👍/👎 to the feedback route:
 *
 *  - submit() is fire-and-forget (returns void): POSTs messageId + threadId +
 *    type to /api/feedback, never blocks, never throws to the UI.
 *  - threadId is read lazily at submit time (the adapter is created once but the
 *    active thread changes).
 *
 * We stub global fetch (client module; no real route).
 */

function msg(id: string): ThreadMessage {
  // Only `id` is read by the adapter; cast the minimal shape.
  return { id } as ThreadMessage;
}

/** A fetch mock typed with fetch's signature so calls index cleanly. */
function stubFetch(impl: typeof fetch = async () => new Response("{}")) {
  const fetchMock = vi.fn<typeof fetch>(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>) {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("feedback adapter", () => {
  it("submit(positive) POSTs thumbs-up payload with the current threadId", () => {
    const fetchMock = stubFetch();

    createFeedbackAdapter(() => "thread-7").submit({
      message: msg("m-1"),
      type: "positive",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentBody(fetchMock)).toEqual({
      messageId: "m-1",
      threadId: "thread-7",
      type: "positive",
    });
  });

  it("submit(negative) forwards type=negative", () => {
    const fetchMock = stubFetch();
    createFeedbackAdapter(() => "t").submit({ message: msg("m"), type: "negative" });
    expect(sentBody(fetchMock).type).toBe("negative");
  });

  it("reads threadId lazily at submit time (not creation time)", () => {
    const fetchMock = stubFetch();
    let current = "before";
    const adapter = createFeedbackAdapter(() => current);
    current = "after";
    adapter.submit({ message: msg("m"), type: "positive" });
    expect(sentBody(fetchMock).threadId).toBe("after");
  });

  it("sends undefined threadId when there is no active thread", () => {
    const fetchMock = stubFetch();
    createFeedbackAdapter(() => undefined).submit({
      message: msg("m"),
      type: "positive",
    });
    expect(sentBody(fetchMock).threadId).toBeUndefined();
  });

  it("swallows fetch rejections (best-effort telemetry, never throws)", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    const adapter = createFeedbackAdapter(() => "t");
    // submit is void + fire-and-forget; the throwing fetch must not surface.
    expect(() =>
      adapter.submit({ message: msg("m"), type: "positive" }),
    ).not.toThrow();
    // let the rejected promise settle so no unhandled rejection leaks.
    await Promise.resolve();
  });
});
