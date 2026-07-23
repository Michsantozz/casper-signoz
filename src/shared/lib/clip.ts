/**
 * Client-side video clipping via mediabunny (WebCodecs). Cuts a `[start, end]`
 * range out of a source video and returns the clip as an mp4 Blob — no server,
 * no upload, no ffmpeg. Used to turn a meeting moment/section into a shareable
 * soundbite straight from the notebook.
 *
 * Generic (no business logic) → lives in shared/lib. mediabunny is a heavy,
 * browser-only bundle, so it is dynamically imported inside the function: the
 * cost is paid only when a user actually clips, never on page load, and it
 * never reaches the server bundle.
 */

/** How the clip is progressing, surfaced to the UI. */
export interface ClipProgress {
  /** 0..1 completion of the conversion. */
  progress: number;
}

export interface ClipOptions {
  /** Source video URL (e.g. Recall's signed S3 mp4 URL). */
  videoUrl: string;
  /** Clip start in seconds (inclusive). */
  start: number;
  /** Clip end in seconds (exclusive). Must be > start. */
  end: number;
  /** Progress callback (0..1) for a UI bar. */
  onProgress?: (p: ClipProgress) => void;
  /** Abort signal — disposes the input and cancels the conversion. */
  signal?: AbortSignal;
}

/** A finished clip: the mp4 bytes plus its playable duration. */
export interface ClipResult {
  blob: Blob;
  durationSeconds: number;
}

/**
 * Cuts `[start, end)` from `videoUrl` and returns an mp4 Blob.
 *
 * Streams the source directly from its URL (UrlSource) — the whole file is not
 * downloaded, only the byte ranges the trim needs. Throws if the range is
 * invalid, the source can't be read, or the conversion is canceled.
 */
export async function clipVideo(options: ClipOptions): Promise<ClipResult> {
  const { videoUrl, start, end, onProgress, signal } = options;

  if (!(end > start)) {
    throw new Error(`Invalid clip range: end (${end}) must be greater than start (${start}).`);
  }

  // Dynamic import: keeps mediabunny out of the initial bundle and off the
  // server. All of these are named exports of the package.
  const {
    Input,
    Output,
    Conversion,
    UrlSource,
    BufferTarget,
    Mp4OutputFormat,
    ALL_FORMATS,
    ConversionCanceledError,
  } = await import("mediabunny");

  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(videoUrl),
  });
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });

  // Aborting disposes the input (cancels in-flight range requests) and cancels
  // the conversion — whichever is running.
  const conversion = await Conversion.init({
    input,
    output,
    trim: { start, end },
  });

  if (onProgress) {
    conversion.onProgress = (progress) => onProgress({ progress });
  }

  const onAbort = () => {
    void conversion.cancel();
    void input.dispose();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof ConversionCanceledError) {
      throw new DOMException("Clip canceled", "AbortError");
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  const buffer = output.target.buffer;
  if (!buffer) {
    throw new Error("Clip produced no output.");
  }

  return {
    blob: new Blob([buffer], { type: "video/mp4" }),
    durationSeconds: end - start,
  };
}

/** Triggers a browser download of a clip Blob under `filename`. */
export function downloadClip(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".mp4") ? filename : `${filename}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
