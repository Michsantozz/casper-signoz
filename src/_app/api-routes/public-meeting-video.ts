import { getPublicMeeting } from "@/server/recall/public-meeting";
import { proxyMediaStream } from "@/server/storage/proxy";

/**
 * Same-origin proxy for a shared meeting's recording (public view). Mirrors
 * meeting-video, but authorization is the unguessable share token (no session):
 * the token resolves to exactly one durable meeting, and only its durable video
 * is served. Keeps the shared player/clip working under the CSP without
 * exposing the object-store URL.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const meeting = await getPublicMeeting(token);
  if (!meeting || !meeting.videoUrl) {
    return new Response(null, { status: 404, statusText: "Not Found" });
  }

  return proxyMediaStream(meeting.videoUrl, req);
}
