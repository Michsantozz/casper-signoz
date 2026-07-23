import "server-only";
import type { DynamicsSnapshot } from "@/server/recall/meeting-repository";

/**
 * LONGITUDINAL team-health analysis — how a team's interaction dynamics evolve
 * across meetings, not within one. This is the layer no meeting tool ships:
 * per-meeting talk-time/interruptions are common, but tracking whether a person
 * is going quiet over weeks, whether friction with a colleague is rising, or
 * whether one voice is taking over the room over time is people-analytics of a
 * TEAM OVER TIME. Pure aggregation over persisted dynamics snapshots — no LLM,
 * no audio, no extra dependency.
 *
 * It also surfaces "signals" — degradations worth acting on (a fading
 * participant, rising interruptions, growing dominance) — which the agent turns
 * into proactive nudges. That's the difference between a passive chart and an
 * assistant that intervenes.
 */

/** A single participant's trajectory across the analyzed window. */
export interface ParticipantTrend {
  name: string;
  /** Meetings this person appeared in. */
  meetings: number;
  /** Average talk share across their meetings, 0..1. */
  avgTalkShare: number;
  /**
   * Talk-share slope: change per meeting, from a least-squares fit over their
   * appearances. Positive = talking more over time, negative = fading out.
   */
  talkShareSlope: number;
  /** Total interruptions this person made across the window. */
  totalInterruptionsMade: number;
  /** Interruptions-made slope (rising friction if positive). */
  interruptionsSlope: number;
  /** First vs last talk share (quick before/after read), 0..1 each. */
  firstShare: number;
  lastShare: number;
}

/** A degradation worth surfacing to the user (basis for a proactive nudge). */
export interface TeamSignal {
  kind:
    | "fading_participant"
    | "rising_dominance"
    | "rising_friction"
    | "declining_balance";
  /** Person the signal is about, when applicable. */
  subject?: string;
  /** Human-readable, e.g. "Marina's participation dropped from 22% to 4%". */
  message: string;
  /** Magnitude 0..1 for ranking (bigger = more urgent). */
  severity: number;
}

/** Whole-team longitudinal summary. */
export interface TeamTrends {
  /** Number of meetings analyzed. */
  meetings: number;
  /** Window bounds (ISO), for display. */
  from: string;
  to: string;
  /** Per-person trajectories, most-present first. */
  participants: ParticipantTrend[];
  /** Team balance over time (one point per meeting), 0..1. */
  balanceSeries: Array<{ at: string; balance: number }>;
  /** Balance slope: positive = getting more even, negative = concentrating. */
  balanceSlope: number;
  /** Actionable degradations, most severe first. */
  signals: TeamSignal[];
}

/** Need at least this many meetings for a trend to mean anything. */
const MIN_MEETINGS = 3;
/** Talk-share drop (first→last) that flags a fading participant. */
const FADE_DROP = 0.12;
/** Talk share above which someone reads as dominating the room. */
const DOMINANCE_SHARE = 0.55;

/** Least-squares slope of y over x = 0..n-1 (change per step). */
function slope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Aggregates the ordered dynamics snapshots into per-person and team-level
 * trends + actionable signals. Returns null if there aren't enough meetings.
 */
export function computeTeamTrends(
  snapshots: DynamicsSnapshot[],
): TeamTrends | null {
  if (snapshots.length < MIN_MEETINGS) return null;
  // Snapshots arrive oldest→newest (repository order); keep that for the series.
  const ordered = snapshots;

  // Per-person time series of talk share + interruptions, in meeting order.
  const shareSeries = new Map<string, number[]>();
  const interruptSeries = new Map<string, number[]>();
  for (const snap of ordered) {
    for (const p of snap.dynamics.participants) {
      if (!shareSeries.has(p.name)) {
        shareSeries.set(p.name, []);
        interruptSeries.set(p.name, []);
      }
      shareSeries.get(p.name)!.push(p.talkShare);
      interruptSeries.get(p.name)!.push(p.interruptionsMade);
    }
  }

  const participants: ParticipantTrend[] = [];
  for (const [name, shares] of shareSeries) {
    const interrupts = interruptSeries.get(name)!;
    participants.push({
      name,
      meetings: shares.length,
      avgTalkShare: shares.reduce((a, b) => a + b, 0) / shares.length,
      talkShareSlope: slope(shares),
      totalInterruptionsMade: interrupts.reduce((a, b) => a + b, 0),
      interruptionsSlope: slope(interrupts),
      firstShare: shares[0],
      lastShare: shares[shares.length - 1],
    });
  }
  participants.sort((a, b) => b.meetings - a.meetings);

  const balanceSeries = ordered.map((s) => ({
    at: s.createdAt.toISOString(),
    balance: s.dynamics.balance,
  }));
  const balanceSlope = slope(balanceSeries.map((b) => b.balance));

  // Derive actionable signals from the trajectories.
  const signals: TeamSignal[] = [];
  for (const p of participants) {
    // Only judge people present in most meetings (a one-off isn't a trend).
    if (p.meetings < MIN_MEETINGS) continue;

    const drop = p.firstShare - p.lastShare;
    if (drop >= FADE_DROP && p.lastShare < p.firstShare) {
      signals.push({
        kind: "fading_participant",
        subject: p.name,
        message: `${p.name}'s participation dropped from ${pct(p.firstShare)} to ${pct(p.lastShare)} across ${p.meetings} meetings`,
        severity: Math.min(1, drop / 0.3),
      });
    }
    if (p.lastShare >= DOMINANCE_SHARE && p.talkShareSlope > 0) {
      signals.push({
        kind: "rising_dominance",
        subject: p.name,
        message: `${p.name} is increasingly dominating — now ${pct(p.lastShare)} of talk time and rising`,
        severity: Math.min(1, p.lastShare),
      });
    }
    if (p.interruptionsSlope > 0.5) {
      signals.push({
        kind: "rising_friction",
        subject: p.name,
        message: `${p.name}'s interruptions are trending up across recent meetings`,
        severity: Math.min(1, p.interruptionsSlope / 3),
      });
    }
  }
  if (balanceSlope < -0.02) {
    signals.push({
      kind: "declining_balance",
      message: `The team's conversation is getting less balanced over time — participation is concentrating in fewer voices`,
      severity: Math.min(1, Math.abs(balanceSlope) * 10),
    });
  }
  signals.sort((a, b) => b.severity - a.severity);

  return {
    meetings: ordered.length,
    from: ordered[0].createdAt.toISOString(),
    to: ordered[ordered.length - 1].createdAt.toISOString(),
    participants,
    balanceSeries,
    balanceSlope,
    signals,
  };
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
