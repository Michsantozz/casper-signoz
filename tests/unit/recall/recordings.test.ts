import { describe, it, expect, vi, afterEach } from "vitest";

// vi.hoisted so the spy exists before the hoisted vi.mock factory runs (the
// factory references it; a plain const would be in the temporal dead zone).
const logSpy = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/shared/lib/logger", () => ({
  createLogger: () => logSpy,
  logger: logSpy,
}));

import { pickRecording } from "@/server/recall/recordings";

/**
 * pickRecording — chooses which recording of a bot's `recordings` array to read.
 * The array is usually length 1, but a bot can have several (re-join, resumed
 * recording); the old `recordings[0]` blindly dropped all but the first. This
 * prefers a transcript-`done` recording and logs the multi-recording case.
 */
const rec = (code?: string) => ({
  media_shortcuts: { transcript: code ? { status: { code } } : null },
});

afterEach(() => vi.restoreAllMocks());

describe("pickRecording", () => {
  it("returns undefined for empty/nullish input", () => {
    expect(pickRecording(undefined)).toBeUndefined();
    expect(pickRecording(null)).toBeUndefined();
    expect(pickRecording([])).toBeUndefined();
  });

  it("returns the only recording when length is 1", () => {
    const only = rec("done");
    expect(pickRecording([only])).toBe(only);
  });

  it("prefers the transcript-done recording, not just the first", () => {
    const first = rec("processing");
    const ready = rec("done");
    logSpy.warn.mockReset();
    expect(pickRecording([first, ready], "bot-1")).toBe(ready);
    // multi-recording is surfaced, not silent
    expect(logSpy.warn).toHaveBeenCalledOnce();
  });

  it("falls back to the first when none are done", () => {
    const first = rec("processing");
    const second = rec("processing");
    expect(pickRecording([first, second])).toBe(first);
  });
});
