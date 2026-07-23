import "server-only";
import { recallFetch } from "@/server/recall/client";
import { findMeetingRecord } from "@/server/recall/meeting-repository";
import { pickRecording } from "@/server/recall/recordings";
import {
  computeMeetingDynamics,
  type MeetingDynamics,
} from "@/server/recall/dynamics";
import type { MeetingHealthInsight } from "@/server/recall/dynamics-insight";
import type { MeetingRecordRow } from "@/shared/db/schema";

/**
 * Meeting detail for the UI (player + karaoke).
 *
 * DURABLE-FIRST: reads the persisted MINUTES + structured transcript + video URL
 * from meeting_records (captured by the enrichment worker into durable storage).
 * Only if those are absent (legacy rows enriched before durable capture, or a
 * capture that hasn't run yet) does it FALL BACK to Recall's signed artifacts,
 * which expire. So a notebook keeps its karaoke/seek/video after Recall expiry.
 *
 * The caller must run within an RLS scope (meeting_records is tenant-scoped).
 */

/** Word with the time (seconds) it's spoken at — basis for the karaoke highlight. */
export interface TranscriptWordView {
  text: string;
  start: number | null;
  end: number | null;
}

/** Contiguous speech from a participant. */
export interface TranscriptUtteranceView {
  speaker: string;
  start: number | null;
  words: TranscriptWordView[];
}

export interface MeetingDetail {
  botId: string;
  record: MeetingRecordRow | null;
  transcript: TranscriptUtteranceView[];
  videoUrl: string | null;
  transcriptState: "ready" | "processing" | "none";
  /** Meeting length in seconds, derived from the transcript timeline. Null if unknown. */
  durationSeconds: number | null;
  /** Team-dynamics / meeting-health metrics. Null if unavailable (no timestamps). */
  dynamics: MeetingDynamics | null;
  /** LLM meeting-health insight. Only when persisted at enrichment (no on-read fallback). */
  dynamicsInsight: MeetingHealthInsight | null;
  /** Screen-share windows (seconds). Drives Screen Intelligence. [] if none. */
  screenshareSpans: Array<{ start: number; end: number | null }>;
}

/**
 * Derives the meeting length from the transcript timeline: the largest word
 * `end` (falling back to `start`) across all utterances. Cheap and migration-
 * free — no separate duration column to backfill. Null when there are no timed
 * words (empty/processing transcript).
 */
export function deriveDurationSeconds(
  transcript: TranscriptUtteranceView[],
): number | null {
  let max = 0;
  for (const u of transcript) {
    for (const w of u.words) {
      const t = w.end ?? w.start;
      if (t != null && t > max) max = t;
    }
  }
  return max > 0 ? Math.round(max) : null;
}

type RecallMediaArtifact = {
  status?: { code?: string };
  data?: { download_url?: string };
} | null;

type RecallBot = {
  id: string;
  recordings?: Array<{
    media_shortcuts?: {
      transcript?: RecallMediaArtifact;
      video_mixed?: RecallMediaArtifact;
    };
  }>;
};

type RawSegment = {
  participant?: { name?: string | null };
  words?: Array<{
    text?: string;
    start_timestamp?: { relative?: number } | null;
    end_timestamp?: { relative?: number } | null;
  }>;
};

/** Builds the full detail of a meeting by botId. */
export async function getMeetingDetail(botId: string): Promise<MeetingDetail> {
  const record = await findMeetingRecord(botId);

  // Durable path: everything the notebook needs is persisted → no Recall call.
  const persistedTranscript = record?.transcriptStruct;
  if (persistedTranscript && persistedTranscript.length > 0) {
    return {
      botId,
      record,
      transcript: persistedTranscript,
      videoUrl: record?.videoUrl ?? null,
      transcriptState: "ready",
      durationSeconds: deriveDurationSeconds(persistedTranscript),
      // Persisted metric wins; legacy rows (enriched before dynamics existed)
      // fall back to computing it on the fly from the stored transcript.
      dynamics: record?.dynamics ?? computeMeetingDynamics(persistedTranscript),
      dynamicsInsight: record?.dynamicsInsight ?? null,
      screenshareSpans: record?.screenshareSpans ?? [],
    };
  }

  // Fallback: fetch Recall's (expiring) signed artifacts. Used for legacy rows
  // and while the meeting is still processing. A persisted videoUrl, if any,
  // still wins over the signed one.
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  // A bot's `recordings` is an array — a re-join/resume can produce more than
  // one. pickRecording prefers the transcript-`done` one; reading `[0]` blindly
  // silently ignored every recording but the first (see recordings.ts).
  const shortcuts = pickRecording(bot?.recordings, botId)?.media_shortcuts;

  // Video: durable URL if we have one, else Recall's signed URL (expires).
  const video = shortcuts?.video_mixed;
  const signedVideoUrl =
    video?.status?.code === "done" ? (video.data?.download_url ?? null) : null;
  const videoUrl = record?.videoUrl ?? signedVideoUrl;

  // Structured transcript with timestamps.
  const transcriptArtifact = shortcuts?.transcript;
  let transcript: TranscriptUtteranceView[] = [];
  // When there's no Recall artifact yet (the common case right after
  // `transcript.done` enqueues the row but before recording metadata is
  // populated), fall back to the DB row's status so the client keeps polling.
  // Leaving this "none" made `useMeetingDetail`'s refetchInterval stop forever,
  // stranding the notebook on "no transcript" until a manual reload.
  let transcriptState: "ready" | "processing" | "none" =
    record?.status === "pending" || record?.status === "processing"
      ? "processing"
      : "none";

  if (transcriptArtifact) {
    const url = transcriptArtifact.data?.download_url;
    if (transcriptArtifact.status?.code === "done" && url) {
      transcriptState = "ready";
      const segments = (await fetch(url)
        .then((r) => r.json())
        .catch(() => [])) as RawSegment[];
      transcript = segments.map(toUtterance);
    } else {
      transcriptState = "processing";
    }
  }

  return {
    botId,
    record,
    transcript,
    videoUrl,
    transcriptState,
    durationSeconds: deriveDurationSeconds(transcript),
    dynamics: record?.dynamics ?? computeMeetingDynamics(transcript),
    dynamicsInsight: record?.dynamicsInsight ?? null,
    screenshareSpans: record?.screenshareSpans ?? [],
  };
}

function toUtterance(seg: RawSegment): TranscriptUtteranceView {
  const words: TranscriptWordView[] = (seg.words ?? []).map((w) => ({
    text: w.text ?? "",
    start: w.start_timestamp?.relative ?? null,
    end: w.end_timestamp?.relative ?? null,
  }));
  return {
    speaker: seg.participant?.name ?? "Unknown",
    start: words.find((w) => w.start != null)?.start ?? null,
    words,
  };
}
