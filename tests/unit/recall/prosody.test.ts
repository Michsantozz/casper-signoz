import { describe, it, expect } from "vitest";
import { scoreTension, type ProsodyWindow } from "@/shared/lib/prosody";

/**
 * scoreTension — fuses the acoustic energy envelope with the timing moments to
 * flag REAL tension (loud + agitated) vs a casual backchannel (quiet + flat).
 * Pure function: takes normalized windows + moment timestamps, returns a score
 * per moment. (analyzeProsody itself needs WebCodecs/mediabunny → browser-only,
 * exercised via the notebook, not here.)
 */

function win(atSeconds: number, loudness: number, agitation: number): ProsodyWindow {
  return { atSeconds, loudness, agitation };
}

describe("scoreTension", () => {
  it("flags a loud + agitated moment as tense", () => {
    const windows = [win(10, 1, 1), win(10.5, 0.9, 0.9)];
    const [score] = scoreTension(windows, [{ atSeconds: 10 }]);
    expect(score.intensity).toBeGreaterThan(0.55);
    expect(score.isTense).toBe(true);
  });

  it("does NOT flag a quiet + flat moment (backchannel)", () => {
    const windows = [win(10, 0.1, 0.05), win(10.5, 0.08, 0.1)];
    const [score] = scoreTension(windows, [{ atSeconds: 10 }]);
    expect(score.intensity).toBeLessThan(0.55);
    expect(score.isTense).toBe(false);
  });

  it("weights loudness above agitation", () => {
    // Loud but flat should out-score quiet but agitated (0.6 vs 0.4 weight).
    const loudFlat = scoreTension([win(5, 1, 0)], [{ atSeconds: 5 }])[0];
    const quietAgitated = scoreTension([win(5, 0, 1)], [{ atSeconds: 5 }])[0];
    expect(loudFlat.intensity).toBeGreaterThan(quietAgitated.intensity);
  });

  it("returns zero intensity when no window is near the moment", () => {
    const windows = [win(100, 1, 1)];
    const [score] = scoreTension(windows, [{ atSeconds: 10 }]);
    expect(score.intensity).toBe(0);
    expect(score.isTense).toBe(false);
  });

  it("scores each moment independently", () => {
    const windows = [win(10, 1, 1), win(30, 0.1, 0.05)];
    const scores = scoreTension(windows, [
      { atSeconds: 10 },
      { atSeconds: 30 },
    ]);
    expect(scores).toHaveLength(2);
    expect(scores[0].isTense).toBe(true);
    expect(scores[1].isTense).toBe(false);
  });
});
