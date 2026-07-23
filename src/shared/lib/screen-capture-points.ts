/**
 * Capture-point selection for Screen Intelligence — decides WHICH seconds of a
 * meeting are worth grabbing a frame from, so the vision model only ever reads a
 * handful of high-signal screens instead of the whole video. Pure and generic
 * (no browser, no business deps) → shared/lib: it takes plain arrays and returns
 * a deduped, capped, ranked list of timestamps with the reason each was picked.
 *
 * Every point must fall inside a screen-share window — a frame with no screen on
 * is worthless to read. The signals (all already produced elsewhere):
 *  - screen-start: the first second of each share window (a new screen appeared);
 *  - deixis: a transcript word that points at the screen ("look here", "olha
 *    aqui", "this number") — the speech confirms the screen matters right then;
 *  - tension: an acoustic/timing tension moment (Phase 1) that lands during a
 *    share — "they got tense discussing THIS on screen".
 * (screen-change by frame-diff is decided later, in the browser, where frames are.)
 */

/** A screen-share window, in seconds (end null = ran to the end of the call). */
export interface Span {
  start: number;
  end: number | null;
}

/** A minimal transcript utterance: a speaker's timestamped words. */
export interface TimedUtterance {
  words: Array<{ text: string; start: number | null }>;
}

/** A picked frame timestamp and why it was chosen. */
export interface CapturePoint {
  atSeconds: number;
  trigger: "screen-start" | "deixis" | "tension";
}

/** Two capture points within this many seconds are treated as the same screen. */
const DEDUP_WINDOW_SECONDS = 4;
/** Hard cap on frames sent for vision (bounds cost + payload). */
const MAX_CAPTURE_POINTS = 12;

/**
 * Deixis terms (PT-BR + EN) that point at the shared screen. Matched as whole
 * words, case/accent-insensitive. Kept deliberately tight — false positives just
 * cost a frame, but the list avoids ultra-common words that would fire constantly.
 */
const DEIXIS_TERMS = [
  // pt-br
  "olha",
  "olhem",
  "veja",
  "vejam",
  "aqui",
  "esse",
  "essa",
  "isso",
  "nesse",
  "nessa",
  "nesta",
  "neste",
  "tela",
  "slide",
  "gráfico",
  "número",
  "coluna",
  "linha",
  // en
  "look",
  "here",
  "this",
  "screen",
  "chart",
  "graph",
  "number",
  "slide",
  "column",
  "row",
];

/** Strips accents + lowercases, so "número"/"grafico" match regardless of input. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const DEIXIS_SET = new Set(DEIXIS_TERMS.map(normalize));

/** True if `t` falls inside any share window (open-ended spans count to +∞). */
export function inAnySpan(t: number, spans: Span[]): boolean {
  return spans.some((s) => t >= s.start && (s.end == null || t <= s.end));
}

/** First second of each share window — a new screen appeared. */
function screenStartPoints(spans: Span[]): CapturePoint[] {
  return spans.map((s) => ({
    atSeconds: s.start,
    trigger: "screen-start" as const,
  }));
}

/**
 * Scans the transcript for deixis words that land inside a share window. One
 * point per matching word (deduped later), so a burst of "olha esse aqui" in the
 * same breath collapses to a single capture.
 */
function deixisPoints(
  utterances: TimedUtterance[],
  spans: Span[],
): CapturePoint[] {
  const points: CapturePoint[] = [];
  for (const u of utterances) {
    for (const w of u.words) {
      if (w.start == null) continue;
      if (!inAnySpan(w.start, spans)) continue;
      // Strip surrounding punctuation, then check the whole word.
      const term = normalize(w.text).replace(/[^\p{L}\p{N}]/gu, "");
      if (term && DEIXIS_SET.has(term)) {
        points.push({ atSeconds: w.start, trigger: "deixis" });
      }
    }
  }
  return points;
}

/** Tension moments (Phase 1) that occurred while a screen was shared. */
function tensionPoints(
  moments: Array<{ atSeconds: number }>,
  spans: Span[],
): CapturePoint[] {
  return moments
    .filter((m) => inAnySpan(m.atSeconds, spans))
    .map((m) => ({ atSeconds: m.atSeconds, trigger: "tension" as const }));
}

/**
 * Priority when two points collapse into one screen — the more specific signal
 * wins the surviving point's label (tension > deixis > screen-start).
 */
const TRIGGER_RANK: Record<CapturePoint["trigger"], number> = {
  tension: 3,
  deixis: 2,
  "screen-start": 1,
};

/**
 * Selects the frames to capture: screen-starts + in-share deixis + in-share
 * tension, deduped to one point per ~screen and capped. Sorted by time so the
 * gallery reads top-to-bottom in meeting order. Returns [] when nothing shares.
 */
export function selectCapturePoints(input: {
  spans: Span[];
  transcript: TimedUtterance[];
  tensionMoments: Array<{ atSeconds: number }>;
}): CapturePoint[] {
  const { spans, transcript, tensionMoments } = input;
  if (!spans.length) return [];

  const all = [
    ...screenStartPoints(spans),
    ...deixisPoints(transcript, spans),
    ...tensionPoints(tensionMoments, spans),
  ].sort((a, b) => a.atSeconds - b.atSeconds);

  // Collapse points within DEDUP_WINDOW_SECONDS into one, keeping the highest-
  // ranked trigger for the survivor.
  const deduped: CapturePoint[] = [];
  for (const p of all) {
    const last = deduped[deduped.length - 1];
    if (last && p.atSeconds - last.atSeconds <= DEDUP_WINDOW_SECONDS) {
      if (TRIGGER_RANK[p.trigger] > TRIGGER_RANK[last.trigger]) {
        last.trigger = p.trigger;
      }
      continue;
    }
    deduped.push({ ...p });
  }

  // If over the cap, keep the most informative: prefer higher-ranked triggers,
  // then spread across time. Simple + deterministic: sort by rank desc, take
  // MAX, then re-sort by time for display.
  if (deduped.length <= MAX_CAPTURE_POINTS) return deduped;
  return deduped
    .slice()
    .sort(
      (a, b) =>
        TRIGGER_RANK[b.trigger] - TRIGGER_RANK[a.trigger] ||
        a.atSeconds - b.atSeconds,
    )
    .slice(0, MAX_CAPTURE_POINTS)
    .sort((a, b) => a.atSeconds - b.atSeconds);
}
