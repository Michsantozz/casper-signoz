import { describe, it, expect } from "vitest";
import { computeTeamTrends } from "@/server/recall/dynamics-trends";
import type { DynamicsSnapshot } from "@/server/recall/meeting-repository";

/**
 * computeTeamTrends — longitudinal aggregation of per-meeting dynamics into
 * per-person trajectories, a team balance series, and actionable signals
 * (fading participant, rising dominance/friction, declining balance). Pure over
 * ordered snapshots. Contract:
 *  - needs >= 3 meetings, else null;
 *  - talk-share slope is the least-squares trend of a person's share;
 *  - a sustained talk-share drop flags a fading participant;
 *  - a high + rising share flags rising dominance;
 *  - a declining balance slope flags declining balance.
 */

/** Builds a snapshot: participants as [name, talkShare, interruptionsMade]. */
function snap(
  day: number,
  balance: number,
  parts: Array<[string, number, number]>,
): DynamicsSnapshot {
  return {
    botId: `bot-${day}`,
    meetingUrl: null,
    // Fixed base date + day offset — deterministic order, no Date.now().
    createdAt: new Date(2026, 0, day),
    dynamics: {
      participants: parts.map(([name, talkShare, interruptionsMade]) => ({
        name,
        talkShare,
        talkSeconds: talkShare * 600,
        turns: 5,
        interruptionsMade,
        interruptionsReceived: 0,
        longestTurnSeconds: 10,
      })),
      totalTalkSeconds: 600,
      turnCount: 10,
      interruptions: parts.reduce((a, [, , x]) => a + x, 0),
      silenceSeconds: 0,
      balance,
      moments: [],
    },
  };
}

describe("computeTeamTrends", () => {
  it("returns null with fewer than 3 meetings", () => {
    const s = [
      snap(1, 1, [["Ana", 0.5, 0]]),
      snap(2, 1, [["Ana", 0.5, 0]]),
    ];
    expect(computeTeamTrends(s)).toBeNull();
  });

  it("flags a fading participant whose share drops over time", () => {
    const s = [
      snap(1, 0.9, [
        ["Ana", 0.5, 0],
        ["Marina", 0.5, 0],
      ]),
      snap(2, 0.8, [
        ["Ana", 0.7, 0],
        ["Marina", 0.3, 0],
      ]),
      snap(3, 0.6, [
        ["Ana", 0.9, 0],
        ["Marina", 0.1, 0],
      ]),
    ];
    const t = computeTeamTrends(s)!;
    const fade = t.signals.find((x) => x.kind === "fading_participant");
    expect(fade?.subject).toBe("Marina");
    const marina = t.participants.find((p) => p.name === "Marina")!;
    expect(marina.talkShareSlope).toBeLessThan(0);
    expect(marina.firstShare).toBeCloseTo(0.5);
    expect(marina.lastShare).toBeCloseTo(0.1);
  });

  it("flags rising dominance for a growing, high share", () => {
    const s = [
      snap(1, 0.7, [
        ["Ana", 0.5, 0],
        ["João", 0.5, 0],
      ]),
      snap(2, 0.6, [
        ["Ana", 0.6, 0],
        ["João", 0.4, 0],
      ]),
      snap(3, 0.4, [
        ["Ana", 0.7, 0],
        ["João", 0.3, 0],
      ]),
    ];
    const t = computeTeamTrends(s)!;
    const dom = t.signals.find((x) => x.kind === "rising_dominance");
    expect(dom?.subject).toBe("Ana");
  });

  it("flags declining team balance", () => {
    const s = [
      snap(1, 0.95, [["Ana", 0.5, 0]]),
      snap(2, 0.7, [["Ana", 0.5, 0]]),
      snap(3, 0.4, [["Ana", 0.5, 0]]),
    ];
    const t = computeTeamTrends(s)!;
    expect(t.balanceSlope).toBeLessThan(0);
    expect(t.signals.some((x) => x.kind === "declining_balance")).toBe(true);
  });

  it("builds a balance series and window bounds", () => {
    const s = [
      snap(1, 0.8, [["Ana", 1, 0]]),
      snap(2, 0.7, [["Ana", 1, 0]]),
      snap(3, 0.6, [["Ana", 1, 0]]),
    ];
    const t = computeTeamTrends(s)!;
    expect(t.meetings).toBe(3);
    expect(t.balanceSeries).toHaveLength(3);
    expect(t.balanceSeries[0].balance).toBeCloseTo(0.8);
    expect(new Date(t.from).getTime()).toBeLessThan(new Date(t.to).getTime());
  });

  it("does not flag a stable, balanced team", () => {
    const s = [
      snap(1, 1, [
        ["Ana", 0.5, 0],
        ["João", 0.5, 0],
      ]),
      snap(2, 1, [
        ["Ana", 0.5, 0],
        ["João", 0.5, 0],
      ]),
      snap(3, 1, [
        ["Ana", 0.5, 0],
        ["João", 0.5, 0],
      ]),
    ];
    const t = computeTeamTrends(s)!;
    expect(t.signals).toHaveLength(0);
  });
});
