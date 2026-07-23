import { describe, it, expect } from "vitest";
import {
  selectCapturePoints,
  inAnySpan,
  type Span,
} from "@/shared/lib/screen-capture-points";

/**
 * selectCapturePoints — decides WHICH seconds to grab a screen frame from. Pure.
 * Contract:
 *  - nothing when no screen was shared (no spans → []);
 *  - every point falls inside a share window (a frame with no screen is useless);
 *  - each share window contributes a screen-start point;
 *  - deixis words ("olha", "this number") inside a window add points;
 *  - tension moments inside a window add points, and win the label when they
 *    collapse with a nearby weaker signal;
 *  - points are deduped per ~screen and capped, sorted by time.
 */

const spans: Span[] = [
  { start: 100, end: 200 },
  { start: 300, end: null }, // open-ended: runs to end of call
];

describe("inAnySpan", () => {
  it("is true inside a window and false outside", () => {
    expect(inAnySpan(150, spans)).toBe(true);
    expect(inAnySpan(250, spans)).toBe(false);
    expect(inAnySpan(99, spans)).toBe(false);
  });
  it("treats an open-ended span as reaching to +infinity", () => {
    expect(inAnySpan(9999, spans)).toBe(true);
  });
});

describe("selectCapturePoints", () => {
  it("returns [] when nothing was shared", () => {
    const out = selectCapturePoints({
      spans: [],
      transcript: [{ words: [{ text: "olha", start: 5 }] }],
      tensionMoments: [{ atSeconds: 5 }],
    });
    expect(out).toEqual([]);
  });

  it("emits a screen-start point per share window", () => {
    const out = selectCapturePoints({
      spans,
      transcript: [],
      tensionMoments: [],
    });
    expect(out.map((p) => p.atSeconds)).toEqual([100, 300]);
    expect(out.every((p) => p.trigger === "screen-start")).toBe(true);
  });

  it("adds deixis points only when the word lands inside a share window", () => {
    const out = selectCapturePoints({
      spans,
      transcript: [
        {
          words: [
            { text: "olha", start: 150 }, // in window → captured
            { text: "aqui", start: 250 }, // outside window → ignored
            { text: "hello", start: 160 }, // not a deixis term → ignored
          ],
        },
      ],
      tensionMoments: [],
    });
    // screen-starts (100, 300) + one deixis at 150.
    const at150 = out.find((p) => p.atSeconds === 150);
    expect(at150?.trigger).toBe("deixis");
    expect(out.some((p) => p.atSeconds === 250)).toBe(false);
    expect(out.some((p) => p.atSeconds === 160)).toBe(false);
  });

  it("matches deixis accent- and case-insensitively", () => {
    const out = selectCapturePoints({
      spans,
      transcript: [{ words: [{ text: "NÚMERO", start: 150 }] }],
      tensionMoments: [],
    });
    expect(out.some((p) => p.atSeconds === 150 && p.trigger === "deixis")).toBe(
      true,
    );
  });

  it("adds tension points only inside a window, and tension wins on collapse", () => {
    // Tension at 100.5 collapses with the screen-start at 100 (within 4s) — the
    // stronger 'tension' label must win the surviving point.
    const out = selectCapturePoints({
      spans,
      transcript: [],
      tensionMoments: [
        { atSeconds: 100.5 }, // in window, collapses with screen-start@100
        { atSeconds: 250 }, // outside any window → ignored
      ],
    });
    const at100 = out.find((p) => Math.round(p.atSeconds) === 100);
    expect(at100?.trigger).toBe("tension");
    expect(out.some((p) => p.atSeconds === 250)).toBe(false);
  });

  it("dedupes points within the collapse window", () => {
    const out = selectCapturePoints({
      spans: [{ start: 100, end: 200 }],
      transcript: [
        {
          words: [
            { text: "olha", start: 101 },
            { text: "esse", start: 102 },
            { text: "aqui", start: 103 },
          ],
        },
      ],
      tensionMoments: [],
    });
    // screen-start@100 + the deixis burst 101-103 all collapse into one screen.
    expect(out).toHaveLength(1);
  });

  it("caps the number of points", () => {
    // 30 distinct share windows → 30 screen-starts, must cap at 12.
    const many: Span[] = Array.from({ length: 30 }, (_, i) => ({
      start: i * 100,
      end: i * 100 + 50,
    }));
    const out = selectCapturePoints({
      spans: many,
      transcript: [],
      tensionMoments: [],
    });
    expect(out.length).toBeLessThanOrEqual(12);
    // Still sorted by time.
    const times = out.map((p) => p.atSeconds);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
