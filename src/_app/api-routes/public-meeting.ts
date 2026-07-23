import { NextResponse } from "next/server";
import { getPublicMeeting } from "@/server/recall/public-meeting";

/**
 * Public (unauthenticated) meeting view by share token — powers /share/[token].
 * No session check: the unguessable token is the authorization. Serves only
 * durably-persisted minutes for a meeting whose owner enabled sharing; unknown
 * or revoked tokens 404 (no leak of whether a botId exists).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const meeting = await getPublicMeeting(token);
  if (!meeting) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(meeting);
}
