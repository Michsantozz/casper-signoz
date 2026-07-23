import "server-only";
import { recallFetch } from "@/server/recall/client";
import { pickRecording } from "@/server/recall/recordings";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("screenshare");

/**
 * Screen-share TIMELINE — when the shared screen was on, in seconds from the
 * recording start. Recall's async `participant_events` artifact emits
 * `screenshare_on` / `screenshare_off` events (see Recall's download-schemas);
 * we pair them into [start, end] spans. This is the "when did anyone share the
 * screen" signal that drives Screen Intelligence: frames are only captured
 * inside these spans, so the vision model never reads a frame with no screen on.
 *
 * Best-effort and dependency-free: reads the already-requested participant_events
 * artifact (recording_config.participant_events is set at bot creation), returns
 * [] when the artifact is absent/unready/malformed. Never throws — a missing
 * timeline just means "no screens to analyze", never a broken enrichment.
 */

/** A contiguous window where the screen was shared, in seconds. */
export interface ScreenshareSpan {
  /** Seconds from recording start when the share began. */
  start: number;
  /** Seconds when the share ended, or null if it ran to the end of the call. */
  end: number | null;
}

/** A raw participant-event as it appears in the async download. Tolerant shape. */
type RawParticipantEvent = {
  action?: { type?: string } | string | null;
  type?: string | null;
  timestamp?: { relative?: number } | null;
  // Some payloads nest the moment differently; we read defensively below.
  start_timestamp?: { relative?: number } | null;
};

type RecallEventsArtifact = {
  status?: { code?: string };
  data?: { download_url?: string };
} | null;

type RecallBot = {
  id: string;
  recordings?: Array<{
    media_shortcuts?: {
      // transcript is read by pickRecording to choose the ready recording.
      transcript?: { status?: { code?: string } } | null;
      participant_events?: RecallEventsArtifact;
    } | null;
  }>;
};

/** Reads the event kind from whichever field Recall used (action.type/type). */
function eventKind(e: RawParticipantEvent): string | null {
  if (typeof e.action === "string") return e.action;
  if (e.action && typeof e.action === "object") return e.action.type ?? null;
  return e.type ?? null;
}

/** Reads the event's relative second, from whichever timestamp field is present. */
function eventSecond(e: RawParticipantEvent): number | null {
  return e.timestamp?.relative ?? e.start_timestamp?.relative ?? null;
}

/**
 * Pairs on/off events into spans. Handles multiple concurrent sharers by tracking
 * a depth counter: a span is open while ≥1 share is active, closed when all stop.
 * A dangling `on` with no matching `off` closes at null (ran to end of call).
 */
export function eventsToSpans(events: RawParticipantEvent[]): ScreenshareSpan[] {
  const timed = events
    .map((e) => ({ kind: eventKind(e), at: eventSecond(e) }))
    .filter(
      (e): e is { kind: string; at: number } =>
        e.at != null &&
        (e.kind === "screenshare_on" || e.kind === "screenshare_off"),
    )
    .sort((a, b) => a.at - b.at);

  const spans: ScreenshareSpan[] = [];
  let depth = 0;
  let openAt: number | null = null;
  for (const e of timed) {
    if (e.kind === "screenshare_on") {
      if (depth === 0) openAt = e.at;
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && openAt != null) {
        // Ignore zero-length blips (off immediately after on).
        if (e.at > openAt) spans.push({ start: openAt, end: e.at });
        openAt = null;
      }
    }
  }
  if (openAt != null) spans.push({ start: openAt, end: null });
  return spans;
}

/**
 * Fetches and parses a bot's screen-share spans from the async participant_events
 * artifact. Returns [] if the artifact isn't ready or has no screenshare events.
 */
export async function fetchScreenshareSpans(
  botId: string,
): Promise<ScreenshareSpan[]> {
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  const artifact = pickRecording(bot?.recordings, botId)?.media_shortcuts
    ?.participant_events;
  const url = artifact?.data?.download_url;
  if (artifact?.status?.code !== "done" || !url) return [];

  try {
    const events = (await fetch(url).then((r) => r.json())) as unknown;
    if (!Array.isArray(events)) return [];
    return eventsToSpans(events as RawParticipantEvent[]);
  } catch (err) {
    log.error({ err, botId }, "span capture failed");
    return [];
  }
}
