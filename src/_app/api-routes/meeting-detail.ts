import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { withUserScope } from "@/shared/db/rls";

/**
 * Meeting detail (minutes + transcript with timestamps + video) for the
 * player/karaoke UI. Scoped to the user: meeting_records is tenant (RLS), so
 * the read runs under withUserScope — only returns the minutes if they belong to the user.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { botId } = await params;
  const detail = await withUserScope(session.user.id, () =>
    getMeetingDetail(botId),
  );

  // No persisted minutes for the user: 404 (doesn't leak another user's meeting).
  if (!detail.record) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const r = detail.record;
  return NextResponse.json({
    botId: detail.botId,
    status: r.status,
    meetingUrl: r.meetingUrl,
    title: r.title,
    summary: r.summary,
    overview: r.overview,
    decisions: r.decisions ?? [],
    actionItems: r.actionItems ?? [],
    topics: r.topics ?? [],
    sections: r.sections ?? [],
    moments: r.moments ?? [],
    soundbites: r.soundbites ?? [],
    talkShares: r.talkShares ?? [],
    dynamics: detail.dynamics,
    dynamicsInsight: detail.dynamicsInsight,
    screenshareSpans: detail.screenshareSpans,
    // Serve the recording through this origin (same-origin proxy) instead of the
    // raw object-store/Recall URL: the clip button (mediabunny fetch) and the
    // <video> player are then subject to `connect-src 'self'` and avoid the
    // object store's missing CORS. The proxy re-resolves the raw URL server-side.
    videoUrl: detail.videoUrl ? `/api/meetings/${detail.botId}/video` : null,
    transcript: detail.transcript,
    transcriptState: detail.transcriptState,
    durationSeconds: detail.durationSeconds,
    shareToken: r.shareToken,
    createdAt: r.createdAt,
  });
}
