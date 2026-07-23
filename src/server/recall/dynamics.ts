import "server-only";
import type { StructuredUtterance } from "@/server/recall/media";

/**
 * Team-dynamics / meeting-health metrics — the "how the team interacted" layer,
 * complementary to the minutes ("what was said"). Derived purely from the
 * word-level transcript timestamps (StructuredUtterance[]), so it needs NO LLM,
 * NO audio, and NO extra dependency: it always works when the transcript has
 * timestamps, and it is cheap enough to run inside enrichment.
 *
 * The unit of analysis is a "turn": one participant's contiguous utterance with
 * a real [start, end] window (from its first/last timestamped word). Everything
 * else — talk share, interruptions, silences, monologues, balance — is measured
 * over the ordered stream of turns.
 */

/** A participant's contiguous speech window, in seconds. */
interface Turn {
  speaker: string;
  start: number;
  end: number;
}

/** Per-participant contribution to the conversation. */
export interface ParticipantDynamics {
  name: string;
  /** Fraction of total talk time, 0..1. */
  talkShare: number;
  /** Seconds this person spoke. */
  talkSeconds: number;
  /** Number of turns taken. */
  turns: number;
  /** Times this person started talking over someone still speaking. */
  interruptionsMade: number;
  /** Times this person was cut off mid-turn by someone else. */
  interruptionsReceived: number;
  /** Longest single uninterrupted turn, in seconds (monologue signal). */
  longestTurnSeconds: number;
}

/** A moment worth surfacing/clipping (tension, monologue, dead air). */
export interface DynamicsMoment {
  kind: "interruption" | "monologue" | "silence";
  atSeconds: number;
  /** Duration of the moment (silence gap, monologue length), in seconds. */
  durationSeconds: number;
  /** Human-readable, e.g. "Ana cut off João" / "45s of silence". */
  label: string;
}

/** Whole-meeting dynamics summary. */
export interface MeetingDynamics {
  participants: ParticipantDynamics[];
  /** Total talk time across everyone, in seconds. */
  totalTalkSeconds: number;
  /** Number of speaker changes (turn-taking count). */
  turnCount: number;
  /** All interruptions across the meeting. */
  interruptions: number;
  /** Total silent gap time between turns, in seconds. */
  silenceSeconds: number;
  /**
   * 0..1 evenness of talk time (1 = perfectly balanced, 0 = one person only).
   * Normalized Shannon entropy of the talk-share distribution.
   */
  balance: number;
  /** Top moments (tension/monologue/dead-air), most significant first. */
  moments: DynamicsMoment[];
}

/** A turn overlapping the previous one by at least this long counts as an
 * interruption (below it is just natural, sloppy turn boundaries). */
const INTERRUPTION_OVERLAP_SECONDS = 0.8;
/** A silent gap this long between turns is a "dead air" moment. */
const SILENCE_GAP_SECONDS = 4;
/** A single turn this long is a "monologue" moment. */
const MONOLOGUE_SECONDS = 90;
/** Cap on emitted moments (keeps the payload and UI bounded). */
const MAX_MOMENTS = 20;

/** Extracts ordered [start, end] turns from utterances (drops untimed ones). */
function toTurns(utterances: StructuredUtterance[]): Turn[] {
  const turns: Turn[] = [];
  for (const u of utterances) {
    let start: number | null = null;
    let end: number | null = null;
    for (const w of u.words) {
      if (w.start != null && (start == null || w.start < start)) start = w.start;
      if (w.end != null && (end == null || w.end > end)) end = w.end;
    }
    if (start != null && end != null && end > start) {
      turns.push({ speaker: u.speaker, start, end });
    }
  }
  // Recall segments are usually ordered, but sort defensively by start.
  return turns.sort((a, b) => a.start - b.start);
}

/** Shannon-entropy balance of a share distribution, normalized to 0..1. */
function computeBalance(shares: number[]): number {
  const nonzero = shares.filter((s) => s > 0);
  if (nonzero.length <= 1) return nonzero.length === 1 ? 0 : 1;
  const entropy = -nonzero.reduce((acc, p) => acc + p * Math.log(p), 0);
  return entropy / Math.log(nonzero.length);
}

/**
 * Computes team-dynamics metrics from a word-level transcript. Returns null when
 * there are no timestamped turns (nothing to measure).
 */
export function computeMeetingDynamics(
  utterances: StructuredUtterance[] | null | undefined,
): MeetingDynamics | null {
  if (!utterances?.length) return null;
  const turns = toTurns(utterances);
  if (turns.length === 0) return null;

  const byName = new Map<string, ParticipantDynamics>();
  const ensure = (name: string): ParticipantDynamics => {
    let p = byName.get(name);
    if (!p) {
      p = {
        name,
        talkShare: 0,
        talkSeconds: 0,
        turns: 0,
        interruptionsMade: 0,
        interruptionsReceived: 0,
        longestTurnSeconds: 0,
      };
      byName.set(name, p);
    }
    return p;
  };

  const moments: DynamicsMoment[] = [];
  let silenceSeconds = 0;
  let interruptions = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const dur = turn.end - turn.start;
    const p = ensure(turn.speaker);
    p.talkSeconds += dur;
    p.turns += 1;
    if (dur > p.longestTurnSeconds) p.longestTurnSeconds = dur;

    if (dur >= MONOLOGUE_SECONDS) {
      moments.push({
        kind: "monologue",
        atSeconds: turn.start,
        durationSeconds: dur,
        label: `${turn.speaker} spoke for ${Math.round(dur)}s uninterrupted`,
      });
    }

    const prev = i > 0 ? turns[i - 1] : null;
    if (prev) {
      // Interruption is attributed to whoever was ACTUALLY still speaking when
      // this turn began — the previous turn with the largest end that overlaps
      // turn.start and belongs to someone else. With 3+ overlapping turns, the
      // immediate predecessor may be the interrupter too (already counted), so
      // we scan back to the genuinely-active different speaker.
      // Scan earlier turns for one that is still ongoing at turn.start and
      // belongs to someone else. Turns are sorted by START, not END, so an older
      // turn can still have the largest end (a long turn others cut into) — we
      // can't early-break on end; we bound the scan by start instead. In
      // practice the overlap window is tiny, so this stays cheap.
      let active: Turn | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const cand = turns[j];
        // Once a candidate STARTED before a full window ago AND we already have
        // a match, older turns can't beat it meaningfully — but to stay correct
        // with long turns we only stop when starts are far behind this one.
        if (turn.start - cand.start > MONOLOGUE_SECONDS && active) break;
        if (cand.speaker !== turn.speaker && cand.end > turn.start) {
          if (!active || cand.end > active.end) active = cand;
        }
      }

      if (active) {
        const overlap = active.end - turn.start;
        if (overlap >= INTERRUPTION_OVERLAP_SECONDS) {
          interruptions += 1;
          p.interruptionsMade += 1;
          ensure(active.speaker).interruptionsReceived += 1;
          moments.push({
            kind: "interruption",
            atSeconds: turn.start,
            durationSeconds: overlap,
            label: `${turn.speaker} cut off ${active.speaker}`,
          });
        }
      } else {
        // No one was speaking into this turn → measure the dead-air gap since
        // the previous turn ended, regardless of whether the speaker changed
        // (a long pause between one person's own turns is still silence).
        const gap = turn.start - prev.end;
        if (gap >= SILENCE_GAP_SECONDS) {
          silenceSeconds += gap;
          moments.push({
            kind: "silence",
            atSeconds: prev.end,
            durationSeconds: gap,
            label: `${Math.round(gap)}s of silence`,
          });
        } else if (gap > 0) {
          silenceSeconds += gap;
        }
      }
    }
  }

  const totalTalkSeconds = [...byName.values()].reduce(
    (a, p) => a + p.talkSeconds,
    0,
  );
  for (const p of byName.values()) {
    p.talkShare = totalTalkSeconds > 0 ? p.talkSeconds / totalTalkSeconds : 0;
  }

  const participants = [...byName.values()].sort(
    (a, b) => b.talkShare - a.talkShare,
  );
  const balance = computeBalance(participants.map((p) => p.talkShare));

  // Rank moments by magnitude (longest silence/monologue, biggest overlap) and
  // cap — the most significant human moments float to the top.
  moments.sort((a, b) => b.durationSeconds - a.durationSeconds);

  return {
    participants,
    totalTalkSeconds,
    turnCount: turns.length,
    interruptions,
    silenceSeconds,
    balance,
    moments: moments.slice(0, MAX_MOMENTS),
  };
}
