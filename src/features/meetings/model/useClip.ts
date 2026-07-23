"use client";

/**
 * Client-side clipping state for the notebook. Wraps shared/lib/clip so the UI
 * can cut a moment/section into a downloadable mp4 soundbite and show progress,
 * tracking WHICH item is being clipped (so only that button spins).
 *
 * One clip at a time: starting a new clip aborts the in-flight one.
 */

import { useCallback, useRef, useState } from "react";
import { clipVideo, downloadClip } from "@/shared/lib/clip";

export type ClipState =
  | { status: "idle" }
  | { status: "clipping"; id: string; progress: number }
  | { status: "error"; id: string; message: string };

export interface RunClipArgs {
  /** Stable id of the item being clipped (moment/section index or key). */
  id: string;
  videoUrl: string;
  start: number;
  end: number;
  /** Download filename (without extension is fine). */
  filename: string;
}

export function useClip() {
  const [state, setState] = useState<ClipState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (args: RunClipArgs) => {
    // Abort any in-flight clip before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ status: "clipping", id: args.id, progress: 0 });
    try {
      const { blob } = await clipVideo({
        videoUrl: args.videoUrl,
        start: args.start,
        end: args.end,
        signal: controller.signal,
        onProgress: ({ progress }) =>
          setState((s) =>
            s.status === "clipping" && s.id === args.id
              ? { ...s, progress }
              : s,
          ),
      });
      downloadClip(blob, args.filename);
      setState({ status: "idle" });
    } catch (err) {
      // A user-triggered abort is not an error to surface.
      if (err instanceof DOMException && err.name === "AbortError") {
        setState({ status: "idle" });
        return;
      }
      setState({
        status: "error",
        id: args.id,
        message: err instanceof Error ? err.message : "Clip failed",
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState({ status: "idle" });
  }, []);

  return { state, run, cancel };
}
