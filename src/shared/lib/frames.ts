/**
 * Client-side FRAME extraction via mediabunny (WebCodecs). Grabs a still image
 * from a video at specific timestamps — the raw material for Screen Intelligence,
 * which reads shared-screen frames with a vision model. No server, no ffmpeg: the
 * frame is decoded in the browser and returned as a JPEG Blob ready to upload.
 *
 * Generic (no business logic) → shared/lib. mediabunny is a heavy, browser-only
 * bundle, so it is dynamically imported inside the function: the cost is paid only
 * when a user actually runs the analysis, never on page load, and it never reaches
 * the server bundle. Streams from the URL (UrlSource) — only the byte ranges each
 * frame needs are fetched, not the whole file.
 */

/** A single extracted frame: the JPEG bytes and the second it was taken at. */
export interface ExtractedFrame {
  atSeconds: number;
  blob: Blob;
}

export interface ExtractFramesOptions {
  /** Source video URL (e.g. the same-origin meeting mp4 proxy). */
  url: string;
  /** Seconds to grab a frame at. Out-of-range timestamps are skipped. */
  timestamps: number[];
  /** Longest edge of the output JPEG, in px (downscaled to bound upload size). */
  maxEdge?: number;
  /** JPEG quality 0..1. */
  quality?: number;
  /** Progress callback (0..1) as frames are decoded. */
  onProgress?: (p: number) => void;
  /** Abort signal — disposes the input and stops decoding. */
  signal?: AbortSignal;
}

/** Default longest-edge downscale — enough for a vision model to read text. */
const DEFAULT_MAX_EDGE = 1280;
const DEFAULT_QUALITY = 0.8;

/**
 * Extracts a JPEG frame at each timestamp. Skips timestamps with no decodable
 * frame (out of range, gap) rather than failing the batch. Throws only if the
 * source has no video track or can't be read at all.
 */
export async function extractFrames(
  options: ExtractFramesOptions,
): Promise<ExtractedFrame[]> {
  const {
    url,
    timestamps,
    maxEdge = DEFAULT_MAX_EDGE,
    quality = DEFAULT_QUALITY,
    onProgress,
    signal,
  } = options;

  if (timestamps.length === 0) return [];

  const { Input, UrlSource, CanvasSink, ALL_FORMATS } = await import(
    "mediabunny"
  );

  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
  const onAbort = () => void input.dispose();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("No video track in the source.");

    // Downscale the longest edge to bound the uploaded JPEG; the sink keeps
    // aspect ratio via `fit: "contain"`.
    const displayW = (await videoTrack.getDisplayWidth()) || maxEdge;
    const displayH = (await videoTrack.getDisplayHeight()) || maxEdge;
    const scale = Math.min(1, maxEdge / Math.max(displayW, displayH));
    const width = Math.max(1, Math.round(displayW * scale));
    const height = Math.max(1, Math.round(displayH * scale));

    const sink = new CanvasSink(videoTrack, { width, height, fit: "contain" });

    const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
    const frames: ExtractedFrame[] = [];

    for (let i = 0; i < sorted.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const at = sorted[i];
      const wrapped = await sink.getCanvas(at);
      if (wrapped) {
        const blob = await canvasToJpeg(wrapped.canvas, quality);
        if (blob) frames.push({ atSeconds: at, blob });
      }
      onProgress?.((i + 1) / sorted.length);
    }

    return frames;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    input.dispose();
  }
}

/** Encodes a canvas (HTMLCanvas or OffscreenCanvas) to a JPEG Blob. */
async function canvasToJpeg(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality: number,
): Promise<Blob | null> {
  // OffscreenCanvas exposes convertToBlob; HTMLCanvasElement exposes toBlob.
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
  );
}
