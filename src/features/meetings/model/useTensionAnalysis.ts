"use client";

/**
 * Client-side TENSION analysis for the notebook. Wraps shared/lib/prosody: on
 * demand, it decodes the meeting audio (mediabunny/WebCodecs), builds the energy
 * envelope, and scores each timing moment — telling apart real tension (a loud,
 * agitated overlap) from a casual backchannel (a quiet, flat one).
 *
 * After the acoustic scoring, it hands the fused per-moment scores + the dynamics
 * metrics to a Server Action (analyzeMeetingBehavior) that has the LLM read the
 * HUMAN BEHAVIOR behind the tense moments (pushback, frustration, disengagement,
 * dominance). No audio/video bytes leave the browser — only numbers and short
 * timing labels. The behavioral read is best-effort: the tension overlay stands
 * on its own if it's null or fails.
 *
 * On demand, not automatic: decoding audio is heavy, so it runs only when the
 * user clicks "analyze tension". One run at a time; the result is a lookup from
 * rounded second → tense/intensity that the UI overlays onto the moments, plus
 * the LLM behavioral insight.
 */

import { useCallback, useRef, useState } from "react";
import { analyzeProsody, scoreTension } from "@/shared/lib/prosody";
import { analyzeMeetingBehavior } from "@/features/meetings/api/actions";
import type {
  MeetingDynamics,
  BehaviorInsight,
} from "@/features/meetings/model/queries";

export interface TensionResult {
  /** rounded-second → { intensity 0..1, isTense }. */
  byAt: Map<number, { intensity: number; isTense: boolean }>;
  /** LLM behavioral read of the tense moments (null when nothing tense/failed). */
  behavior: BehaviorInsight | null;
}

export type TensionState =
  | { status: "idle" }
  | { status: "analyzing"; progress: number }
  | { status: "reading" }
  | { status: "done"; result: TensionResult }
  | { status: "error"; message: string };

export function useTensionAnalysis() {
  const [state, setState] = useState<TensionState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (botId: string, videoUrl: string, dynamics: MeetingDynamics) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ status: "analyzing", progress: 0 });
      try {
        const windows = await analyzeProsody({
          url: videoUrl,
          signal: controller.signal,
          onProgress: (progress) =>
            setState((s) =>
              s.status === "analyzing" ? { ...s, progress } : s,
            ),
        });
        const scores = scoreTension(windows, dynamics.moments);
        const byAt = new Map(
          scores.map((s) => [
            Math.round(s.atSeconds),
            { intensity: s.intensity, isTense: s.isTense },
          ]),
        );

        // Behavioral read over the tense moments — best-effort. The acoustic
        // labels feed the moment context; only numbers + labels cross the wire.
        setState({ status: "reading" });
        const scoreByAt = new Map(scores.map((s) => [Math.round(s.atSeconds), s]));
        const behaviorMoments = dynamics.moments.map((m) => {
          const s = scoreByAt.get(Math.round(m.atSeconds));
          return {
            atSeconds: m.atSeconds,
            kind: m.kind,
            label: m.label,
            intensity: s?.intensity ?? 0,
            isTense: s?.isTense ?? false,
          };
        });
        const metrics = {
          balance: dynamics.balance,
          interruptions: dynamics.interruptions,
          silenceSeconds: dynamics.silenceSeconds,
          participants: dynamics.participants.map((p) => ({
            name: p.name,
            talkShare: p.talkShare,
            interruptionsMade: p.interruptionsMade,
            longestTurnSeconds: p.longestTurnSeconds,
          })),
        };

        let behavior: BehaviorInsight | null = null;
        const res = await analyzeMeetingBehavior(botId, behaviorMoments, metrics);
        if (!controller.signal.aborted && res.ok) behavior = res.insight;

        if (controller.signal.aborted) return;
        setState({ status: "done", result: { byAt, behavior } });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setState({ status: "idle" });
          return;
        }
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Analysis failed",
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  return { state, run };
}
