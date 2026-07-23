import { getSession } from "@/features/auth/model/session";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { proxyMediaStream } from "@/server/storage/proxy";
import { withUserScope } from "@/shared/db/rls";

/**
 * Same-origin proxy for a meeting's recording (owner view). The client's
 * `videoUrl` points here instead of at the object store, so the clip button
 * (mediabunny) and the <video> player fetch from 'self' — satisfying the CSP's
 * `connect-src 'self'` and sidestepping the object store's missing CORS.
 *
 * Authorization mirrors the meeting-detail route: session + RLS. The raw
 * storage/Recall URL is resolved server-side and never leaves the server; only
 * its bytes are streamed back. Range requests are forwarded (see proxyMediaStream).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return new Response(null, { status: 401, statusText: "Unauthorized" });
  }

  const { botId } = await params;
  const detail = await withUserScope(session.user.id, () =>
    getMeetingDetail(botId),
  );

  // No persisted meeting for this user, or no video captured → 404 (doesn't
  // leak another user's meeting).
  if (!detail.record || !detail.videoUrl) {
    return new Response(null, { status: 404, statusText: "Not Found" });
  }

  return proxyMediaStream(detail.videoUrl, req);
}
