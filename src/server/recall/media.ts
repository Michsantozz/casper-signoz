import "server-only";
import { recallFetch } from "@/server/recall/client";
import { pickRecording } from "@/server/recall/recordings";
import { uploadObjectStream } from "@/server/storage/s3";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("media");

// Hard ceiling for a captured recording. A long meeting is large but bounded;
// anything past this is almost certainly wrong (or hostile) and would risk the
// worker. Enforced two ways: reject an oversized declared Content-Length up
// front, and abort mid-stream if the actual bytes exceed it. See audit fix #6.
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Durable capture of a meeting's media, so the notebook survives Recall's
 * artifact expiry (Recall's transcript/video URLs are signed and expire in
 * hours-to-days). Called by the enrichment worker when minutes become "done":
 *  - the WORD-LEVEL transcript is downloaded and normalized to the UI shape,
 *    then persisted as jsonb in meeting_records.transcript_struct;
 *  - the mixed VIDEO is downloaded from Recall and re-uploaded to our own object
 *    storage (S3/MinIO), yielding a permanent URL.
 *
 * Best-effort: any failure here returns null for that piece and is logged — it
 * must never fail the whole enrichment (the text summary is the priority).
 */

/** UI-shaped utterance (mirrors TranscriptUtteranceView in meeting-detail). */
export interface StructuredUtterance {
  speaker: string;
  start: number | null;
  words: Array<{ text: string; start: number | null; end: number | null }>;
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

export interface CapturedMedia {
  transcriptStruct: StructuredUtterance[] | null;
  videoUrl: string | null;
}

/** Normalizes a raw Recall segment to the persisted/UI utterance shape. */
function toUtterance(seg: RawSegment): StructuredUtterance {
  const words = (seg.words ?? []).map((w) => ({
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

/**
 * Downloads a bot's word-level transcript + copies its mixed video to durable
 * storage. `userId` scopes the stored object key to the owner. Returns nulls for
 * pieces that aren't ready or that fail — never throws.
 */
export async function captureMeetingMedia(
  botId: string,
  userId: string | null,
): Promise<CapturedMedia> {
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  }).catch(() => null);

  const shortcuts = pickRecording(bot?.recordings, botId)?.media_shortcuts;

  // Independentes (ambos só leem `shortcuts`; nenhum consome a saída do outro):
  // um baixa+parseia o transcript, o outro faz stream do vídeo → storage. Em
  // paralelo o wall-clock do enrich cai para o mais lento dos dois, não a soma.
  const [transcriptStruct, videoUrl] = await Promise.all([
    captureTranscript(shortcuts?.transcript),
    captureVideo(shortcuts?.video_mixed, botId, userId),
  ]);

  return { transcriptStruct, videoUrl };
}

/** Downloads + normalizes the word-level transcript, or null if not ready. */
async function captureTranscript(
  artifact: RecallMediaArtifact | undefined,
): Promise<StructuredUtterance[] | null> {
  const url = artifact?.data?.download_url;
  if (artifact?.status?.code !== "done" || !url) return null;
  try {
    const segments = (await fetch(url).then((r) => r.json())) as RawSegment[];
    if (!Array.isArray(segments)) return null;
    return segments.map(toUtterance);
  } catch (err) {
    log.error({ err }, "transcript capture failed");
    return null;
  }
}

/**
 * Downloads the mixed video from Recall and re-uploads it to our storage.
 * Returns the permanent URL, or null if not ready / storage unconfigured /
 * download fails. Storage errors are swallowed (the signed-URL fallback in
 * getMeetingDetail still works until Recall expires it).
 */
async function captureVideo(
  artifact: RecallMediaArtifact | undefined,
  botId: string,
  userId: string | null,
): Promise<string | null> {
  const url = artifact?.data?.download_url;
  if (artifact?.status?.code !== "done" || !url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) return null;

    // Reject up front if Recall declares a size beyond our ceiling — avoids even
    // starting a doomed multi-GB transfer.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
      log.error(
        { botId, declared, max: MAX_VIDEO_BYTES },
        "video capture skipped: recording exceeds max size",
      );
      return null;
    }

    // Stream Recall → object storage without buffering the whole video in RAM;
    // the upload aborts if the actual byte count exceeds MAX_VIDEO_BYTES.
    const uploaded = await uploadObjectStream({
      // Namespace by owner; anonymous bots (no userId) go under "_shared".
      userId: userId ?? "_shared",
      filename: `meeting-${botId}.mp4`,
      contentType: "video/mp4",
      body: res.body,
      maxBytes: MAX_VIDEO_BYTES,
    });
    return uploaded.url;
  } catch (err) {
    log.error({ err, botId }, "video capture failed");
    return null;
  }
}
