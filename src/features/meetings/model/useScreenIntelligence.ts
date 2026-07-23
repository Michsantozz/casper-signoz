"use client";

/**
 * Client-side SCREEN INTELLIGENCE for the notebook. On demand, it reads the
 * content of the shared screen at the key moments of a meeting:
 *  1. pick capture points (screen-start + in-share deixis + in-share tension);
 *  2. extract those frames from the meeting mp4 in-browser (mediabunny);
 *  3. upload each frame to object storage (/api/upload → public URL);
 *  4. a Server Action runs the vision model over the frames + transcript excerpts.
 *
 * On demand, not automatic: decoding video is heavy, so it runs only when the
 * user clicks "analyze screens". One run at a time. Gated on there being at least
 * one screen-share window — nothing to read otherwise.
 */

import { useCallback, useRef, useState } from "react";
import {
  selectCapturePoints,
  type Span,
  type TimedUtterance,
} from "@/shared/lib/screen-capture-points";
import { extractFrames } from "@/shared/lib/frames";
import { analyzeMeetingScreens } from "@/features/meetings/api/actions";
import type { ScreenInsight } from "@/features/meetings/model/queries";

export type ScreenState =
  | { status: "idle" }
  | { status: "capturing"; progress: number }
  | { status: "reading" }
  | { status: "done"; insight: ScreenInsight | null }
  | { status: "error"; message: string };

/** Uploads a JPEG blob to object storage, returns its public URL. */
async function uploadFrame(blob: Blob, atSeconds: number): Promise<string> {
  const form = new FormData();
  form.append("file", new File([blob], `screen-${Math.round(atSeconds)}.jpg`, {
    type: "image/jpeg",
  }));
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      `Upload failed (${res.status})${detail?.error ? `: ${detail.error}` : ""}`,
    );
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}

export function useScreenIntelligence() {
  const [state, setState] = useState<ScreenState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (input: {
      botId: string;
      videoUrl: string;
      spans: Span[];
      transcript: TimedUtterance[];
      tensionMoments: Array<{ atSeconds: number }>;
    }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const points = selectCapturePoints({
        spans: input.spans,
        transcript: input.transcript,
        tensionMoments: input.tensionMoments,
      });
      if (points.length === 0) {
        setState({ status: "done", insight: null });
        return;
      }

      setState({ status: "capturing", progress: 0 });
      try {
        const frames = await extractFrames({
          url: input.videoUrl,
          timestamps: points.map((p) => p.atSeconds),
          signal: controller.signal,
          onProgress: (progress) =>
            setState((s) =>
              s.status === "capturing" ? { ...s, progress } : s,
            ),
        });
        if (controller.signal.aborted) return;
        if (frames.length === 0) {
          setState({ status: "done", insight: null });
          return;
        }

        // Upload each frame, then pair its URL with the capture trigger (matched
        // by rounded second). Triggers not in the capture-point vocabulary are
        // never produced here, so the cast is safe.
        const triggerAt = new Map(
          points.map((p) => [Math.round(p.atSeconds), p.trigger]),
        );
        const uploaded = await Promise.all(
          frames.map(async (f) => ({
            url: await uploadFrame(f.blob, f.atSeconds),
            atSeconds: f.atSeconds,
            trigger: triggerAt.get(Math.round(f.atSeconds)) ?? "screen-start",
          })),
        );
        if (controller.signal.aborted) return;

        setState({ status: "reading" });
        const res = await analyzeMeetingScreens(input.botId, uploaded);
        if (controller.signal.aborted) return;
        if (res.ok) {
          setState({ status: "done", insight: res.insight });
        } else {
          setState({ status: "error", message: res.error });
        }
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
