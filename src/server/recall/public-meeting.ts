import "server-only";
import { findMeetingByShareToken } from "@/server/recall/meeting-repository";
import {
  deriveDurationSeconds,
  type TranscriptUtteranceView,
} from "@/server/recall/meeting-detail";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Public (unauthenticated) meeting view, resolved by share token.
 *
 * DURABLE-ONLY: unlike the owner's detail, the public page never falls back to
 * Recall's signed artifacts — it serves ONLY what's persisted in meeting_records
 * (minutes + word-level transcript + durable video URL). A shared link that
 * outlives Recall's expiry keeps working; a meeting whose media was never
 * captured durably simply shows no video.
 *
 * Reads under withSystemScope (no user), narrowed to the single row matching the
 * unguessable token with status="done" — the token IS the authorization.
 */

export interface PublicMeetingView {
  /** Best-effort title (first sentence of the summary). */
  title: string;
  summary: string | null;
  overview: string | null;
  decisions: string[];
  actionItems: Array<{ task: string; owner: string | null }>;
  topics: string[];
  sections: Array<{
    title: string;
    bullets: string[];
    startSeconds: number | null;
  }>;
  moments: Array<{
    label: string;
    kind: "topic" | "action" | "question" | "objection";
    atSeconds: number | null;
  }>;
  talkShares: Array<{ name: string; share: number }>;
  transcript: TranscriptUtteranceView[];
  videoUrl: string | null;
  durationSeconds: number | null;
  createdAt: string;
}

function deriveTitle(summary: string | null): string {
  const s = summary?.trim();
  if (!s) return "Shared meeting";
  const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

/** Resolves a public meeting by share token, or null when unknown/revoked. */
export async function getPublicMeeting(
  token: string,
): Promise<PublicMeetingView | null> {
  const record = await withSystemScope(() => findMeetingByShareToken(token));
  if (!record) return null;

  const transcript = record.transcriptStruct ?? [];
  return {
    title: deriveTitle(record.summary),
    summary: record.summary,
    overview: record.overview,
    decisions: record.decisions ?? [],
    actionItems: record.actionItems ?? [],
    topics: record.topics ?? [],
    sections: record.sections ?? [],
    moments: record.moments ?? [],
    talkShares: record.talkShares ?? [],
    transcript,
    // Serve through the same-origin proxy (see meeting-video route): the shared
    // player/clip fetch from 'self', satisfying the CSP and the object store's
    // missing CORS. Keyed by the share token, which is the authorization.
    videoUrl: record.videoUrl ? `/api/public/meetings/${token}/video` : null,
    durationSeconds: deriveDurationSeconds(transcript),
    createdAt: record.createdAt.toISOString(),
  };
}
