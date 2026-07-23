import { describe, it, expect } from "vitest";
import { computeMeetingDynamics } from "@/server/recall/dynamics";
import type { StructuredUtterance } from "@/server/recall/media";

/**
 * computeMeetingDynamics — team-dynamics / meeting-health metrics from the
 * word-level transcript. Pure timestamp math (no LLM/audio). Contract:
 *  - talk time per person is the sum of its words' [start,end] durations;
 *  - a turn starting >=0.8s before the previous speaker finished = interruption;
 *  - a gap >=4s between turns = silence moment; smaller gaps still accrue time;
 *  - a single turn >=90s = monologue;
 *  - balance is normalized Shannon entropy of the talk-share distribution;
 *  - no timestamps / empty input → null.
 */

/** Builds an utterance from a speaker and [start,end] word spans. */
function utt(
  speaker: string,
  spans: Array<[number, number]>,
): StructuredUtterance {
  return {
    speaker,
    start: spans[0]?.[0] ?? null,
    words: spans.map(([start, end], i) => ({
      text: `w${i}`,
      start,
      end,
    })),
  };
}

describe("computeMeetingDynamics", () => {
  it("returns null for empty or missing transcript", () => {
    expect(computeMeetingDynamics(null)).toBeNull();
    expect(computeMeetingDynamics(undefined)).toBeNull();
    expect(computeMeetingDynamics([])).toBeNull();
  });

  it("returns null when no words carry timestamps", () => {
    const untimed: StructuredUtterance = {
      speaker: "Ana",
      start: null,
      words: [{ text: "hi", start: null, end: null }],
    };
    expect(computeMeetingDynamics([untimed])).toBeNull();
  });

  it("computes talk share and seconds per participant", () => {
    // Ana: 6s total, João: 2s total → 75% / 25%.
    const d = computeMeetingDynamics([
      utt("Ana", [
        [0, 3],
        [3, 6],
      ]),
      utt("João", [[7, 9]]),
    ])!;
    expect(d).not.toBeNull();
    const ana = d.participants.find((p) => p.name === "Ana")!;
    const joao = d.participants.find((p) => p.name === "João")!;
    expect(ana.talkSeconds).toBeCloseTo(6);
    expect(joao.talkSeconds).toBeCloseTo(2);
    expect(ana.talkShare).toBeCloseTo(0.75);
    expect(joao.talkShare).toBeCloseTo(0.25);
    // Sorted by share descending.
    expect(d.participants[0].name).toBe("Ana");
    expect(d.totalTalkSeconds).toBeCloseTo(8);
    expect(d.turnCount).toBe(2);
  });

  it("detects an interruption when a turn overlaps the previous speaker", () => {
    // Ana talks [0,10]; João starts at 8 → 2s overlap (>=0.8) = interruption.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 10]]),
      utt("João", [[8, 12]]),
    ])!;
    expect(d.interruptions).toBe(1);
    const joao = d.participants.find((p) => p.name === "João")!;
    const ana = d.participants.find((p) => p.name === "Ana")!;
    expect(joao.interruptionsMade).toBe(1);
    expect(ana.interruptionsReceived).toBe(1);
    expect(d.moments.some((m) => m.kind === "interruption")).toBe(true);
  });

  it("does not count a tiny overlap as an interruption", () => {
    // 0.3s overlap < 0.8s threshold → natural turn boundary, not an interruption.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("João", [[4.7, 8]]),
    ])!;
    expect(d.interruptions).toBe(0);
  });

  it("records a silence moment for a long gap between turns", () => {
    // 5s gap (>=4) between Ana ending at 5 and João starting at 10.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("João", [[10, 12]]),
    ])!;
    expect(d.silenceSeconds).toBeCloseTo(5);
    const silence = d.moments.find((m) => m.kind === "silence");
    expect(silence).toBeTruthy();
    expect(silence!.atSeconds).toBeCloseTo(5);
    expect(silence!.durationSeconds).toBeCloseTo(5);
  });

  it("flags a monologue for a very long single turn", () => {
    // 120s single turn (>=90) = monologue.
    const d = computeMeetingDynamics([utt("Ana", [[0, 120]])])!;
    const mono = d.moments.find((m) => m.kind === "monologue");
    expect(mono).toBeTruthy();
    expect(d.participants[0].longestTurnSeconds).toBeCloseTo(120);
  });

  it("scores balance high when talk time is even, low when dominated", () => {
    const even = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("João", [[6, 11]]),
    ])!;
    // Two equal speakers → perfect balance.
    expect(even.balance).toBeCloseTo(1);

    const dominated = computeMeetingDynamics([
      utt("Ana", [[0, 100]]),
      utt("João", [[101, 102]]),
    ])!;
    expect(dominated.balance).toBeLessThan(0.3);
  });

  it("counts silence between consecutive turns of the SAME speaker", () => {
    // Ana speaks [0,5], pauses, then speaks again [12,14]: a 7s gap that the
    // old logic ignored because the speaker didn't change.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("Ana", [[12, 14]]),
    ])!;
    expect(d.silenceSeconds).toBeCloseTo(7);
    expect(d.moments.some((m) => m.kind === "silence")).toBe(true);
  });

  it("attributes a 3-way overlap to the genuinely active speaker", () => {
    // Ana [0,20] talks long; João [5,7] cuts in briefly; Marina [8,12] cuts in
    // while ANA is still going (not João, who already finished at 7). Marina's
    // interruption must be credited to Ana, not to the immediate predecessor João.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 20]]),
      utt("João", [[5, 7]]),
      utt("Marina", [[8, 12]]),
    ])!;
    const ana = d.participants.find((p) => p.name === "Ana")!;
    const marina = d.participants.find((p) => p.name === "Marina")!;
    // Marina interrupted Ana (still active), João interrupted Ana too.
    expect(marina.interruptionsMade).toBe(1);
    expect(ana.interruptionsReceived).toBe(2);
    const marinaCut = d.moments.find(
      (m) => m.kind === "interruption" && m.label.startsWith("Marina"),
    );
    expect(marinaCut?.label).toBe("Marina cut off Ana");
  });

  it("does not count a gap after someone else's turn ended as silence-with-interruption", () => {
    // Speaker change but with a clean gap (no overlap) → still silence, not
    // interruption. Guards the branch order in the rewritten loop.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("João", [[11, 13]]),
    ])!;
    expect(d.interruptions).toBe(0);
    expect(d.silenceSeconds).toBeCloseTo(6);
  });

  it("caps and orders moments by magnitude", () => {
    // Two silences of different lengths — the larger must come first.
    const d = computeMeetingDynamics([
      utt("Ana", [[0, 5]]),
      utt("João", [[10, 12]]), // 5s gap
      utt("Ana", [[25, 27]]), // 13s gap
    ])!;
    const silences = d.moments.filter((m) => m.kind === "silence");
    expect(silences.length).toBe(2);
    expect(silences[0].durationSeconds).toBeGreaterThanOrEqual(
      silences[1].durationSeconds,
    );
  });
});
