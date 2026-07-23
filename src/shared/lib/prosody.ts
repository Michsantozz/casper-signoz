/**
 * Client-side PROSODY analysis — the "how it sounded" signal that timing alone
 * can't give. Decodes the meeting audio via mediabunny (WebCodecs, browser-only)
 * and measures acoustic energy over time: loudness (RMS) and a pitch/agitation
 * proxy (zero-crossing rate). Fused with the timing-based dynamics moments, this
 * separates REAL tension (an overlap with a loud, agitated voice) from a casual
 * backchannel (an overlap that's quiet and flat).
 *
 * Generic (no business logic) → shared/lib. mediabunny is a heavy, browser-only
 * bundle, so it is dynamically imported inside the function: the cost is paid
 * only when a user actually runs the analysis, never on page load, and it never
 * reaches the server bundle.
 */

/** Acoustic energy of one time window. */
export interface ProsodyWindow {
  /** Window center, in seconds. */
  atSeconds: number;
  /** RMS loudness, 0..1 (normalized against the meeting's own peak). */
  loudness: number;
  /** Zero-crossing rate, 0..1 — proxy for pitch/agitation (higher = tenser). */
  agitation: number;
}

/** Window length for the energy envelope, in seconds. */
const WINDOW_SECONDS = 0.5;

export interface ProsodyOptions {
  /** Source audio/video URL (e.g. the durable meeting mp4). */
  url: string;
  /** Progress callback (0..1) while decoding. */
  onProgress?: (p: number) => void;
  /** Abort signal — disposes the input and stops decoding. */
  signal?: AbortSignal;
}

/**
 * Decodes `url` and returns a per-window energy envelope (loudness + agitation),
 * normalized to the meeting's own peak so it's comparable across recordings.
 * Throws if the source has no audio or can't be read.
 */
export async function analyzeProsody(
  options: ProsodyOptions,
): Promise<ProsodyWindow[]> {
  const { url, onProgress, signal } = options;

  const { Input, UrlSource, ALL_FORMATS, AudioBufferSink } = await import(
    "mediabunny"
  );

  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
  const onAbort = () => void input.dispose();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error("No audio track in the source.");

    const duration = await input.computeDuration();
    const sink = new AudioBufferSink(audioTrack);

    // Accumulate RMS energy + zero-crossings into fixed [WINDOW_SECONDS] bins.
    const binCount = Math.max(1, Math.ceil(duration / WINDOW_SECONDS));
    const sumSquares = new Float64Array(binCount);
    const crossings = new Float64Array(binCount);
    const sampleCounts = new Float64Array(binCount);

    for await (const { buffer, timestamp } of sink.buffers()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rate = buffer.sampleRate;
      // Mix down to mono by averaging channels.
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c));
      }
      const frames = buffer.length;
      let prev = 0;
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (const ch of channels) s += ch[i];
        s /= channels.length;

        const t = timestamp + i / rate;
        const bin = Math.min(binCount - 1, Math.floor(t / WINDOW_SECONDS));
        sumSquares[bin] += s * s;
        sampleCounts[bin] += 1;
        // Sign change = zero crossing (agitation/pitch proxy).
        if (i > 0 && (s >= 0 ? 1 : -1) !== (prev >= 0 ? 1 : -1)) {
          crossings[bin] += 1;
        }
        prev = s;
      }
      if (onProgress && duration > 0) {
        onProgress(Math.min(1, (timestamp + buffer.duration) / duration));
      }
    }

    // Build the raw envelope, then normalize both channels to their own peak.
    const windows: ProsodyWindow[] = [];
    let peakLoud = 0;
    let peakAgit = 0;
    for (let bin = 0; bin < binCount; bin++) {
      const n = sampleCounts[bin];
      const rms = n > 0 ? Math.sqrt(sumSquares[bin] / n) : 0;
      const zcr = n > 0 ? crossings[bin] / n : 0;
      if (rms > peakLoud) peakLoud = rms;
      if (zcr > peakAgit) peakAgit = zcr;
      windows.push({
        atSeconds: bin * WINDOW_SECONDS + WINDOW_SECONDS / 2,
        loudness: rms,
        agitation: zcr,
      });
    }
    for (const w of windows) {
      w.loudness = peakLoud > 0 ? w.loudness / peakLoud : 0;
      w.agitation = peakAgit > 0 ? w.agitation / peakAgit : 0;
    }
    return windows;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    input.dispose();
  }
}

/** A timing moment enriched with the acoustic energy at its timestamp. */
export interface TensionScore {
  atSeconds: number;
  /** 0..1 — how loud+agitated the audio was at this moment. */
  intensity: number;
  /** True when the acoustic energy confirms this is real tension, not backchannel. */
  isTense: boolean;
}

/** Above this fused intensity, an overlap reads as real tension. */
const TENSION_THRESHOLD = 0.55;

/** Average energy in the window around `atSeconds`. */
function energyAt(windows: ProsodyWindow[], atSeconds: number): number {
  const near = windows.filter(
    (w) => Math.abs(w.atSeconds - atSeconds) <= WINDOW_SECONDS,
  );
  if (near.length === 0) return 0;
  // Loudness weighted a bit higher than agitation — a raised voice is the
  // strongest tension signal; agitation refines it.
  const avg =
    near.reduce((a, w) => a + 0.6 * w.loudness + 0.4 * w.agitation, 0) /
    near.length;
  return Math.min(1, avg);
}

/**
 * Scores each moment's acoustic intensity and flags the tense ones. Pure — takes
 * the prosody envelope and the moments' timestamps, returns a score per moment.
 */
export function scoreTension(
  windows: ProsodyWindow[],
  moments: Array<{ atSeconds: number }>,
): TensionScore[] {
  return moments.map((m) => {
    const intensity = energyAt(windows, m.atSeconds);
    return {
      atSeconds: m.atSeconds,
      intensity,
      isTense: intensity >= TENSION_THRESHOLD,
    };
  });
}
