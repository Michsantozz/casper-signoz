import { describe, it, expect } from "vitest";
import { eventsToSpans } from "@/server/recall/screenshare";

/**
 * eventsToSpans — pairs Recall's screenshare_on/screenshare_off participant
 * events into [start, end] windows. Contract:
 *  - a simple on→off pair becomes one span;
 *  - a dangling `on` (no off) closes at null (ran to end of call);
 *  - overlapping shares (two people) collapse via a depth counter into one span;
 *  - non-screenshare events and untimed events are ignored;
 *  - zero-length blips (off at the same instant as on) are dropped;
 *  - the kind is read from either `action.type`, `type`, or a string `action`.
 */

describe("eventsToSpans", () => {
  it("pairs a simple on→off into one span", () => {
    const spans = eventsToSpans([
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 50 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: 50 }]);
  });

  it("closes a dangling on at null (ran to end of call)", () => {
    const spans = eventsToSpans([
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: null }]);
  });

  it("collapses overlapping shares into one span (depth counter)", () => {
    // A shares at 10, B also shares at 20, A stops at 30, B stops at 40.
    // The screen was continuously shared 10→40 → one span.
    const spans = eventsToSpans([
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
      { action: { type: "screenshare_on" }, timestamp: { relative: 20 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 30 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 40 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: 40 }]);
  });

  it("produces separate spans for separate shares", () => {
    const spans = eventsToSpans([
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 20 } },
      { action: { type: "screenshare_on" }, timestamp: { relative: 60 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 90 } },
    ]);
    expect(spans).toEqual([
      { start: 10, end: 20 },
      { start: 60, end: 90 },
    ]);
  });

  it("ignores non-screenshare and untimed events", () => {
    const spans = eventsToSpans([
      { action: { type: "webcam_on" }, timestamp: { relative: 5 } },
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
      { action: { type: "chat_message" }, timestamp: { relative: 15 } },
      { action: { type: "screenshare_off" }, timestamp: null },
      { action: { type: "screenshare_off" }, timestamp: { relative: 50 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: 50 }]);
  });

  it("drops zero-length blips", () => {
    const spans = eventsToSpans([
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
      { action: { type: "screenshare_off" }, timestamp: { relative: 10 } },
    ]);
    expect(spans).toEqual([]);
  });

  it("reads the kind from a bare `type` field too", () => {
    const spans = eventsToSpans([
      { type: "screenshare_on", timestamp: { relative: 10 } },
      { type: "screenshare_off", timestamp: { relative: 30 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: 30 }]);
  });

  it("sorts out-of-order events before pairing", () => {
    const spans = eventsToSpans([
      { action: { type: "screenshare_off" }, timestamp: { relative: 50 } },
      { action: { type: "screenshare_on" }, timestamp: { relative: 10 } },
    ]);
    expect(spans).toEqual([{ start: 10, end: 50 }]);
  });
});
