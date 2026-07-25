import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicMeetingView } from "@/features/meetings";
import { getPublicMeeting } from "@/features/meetings/api/public-meeting";

export const metadata: Metadata = {
  title: "Shared meeting | Casper Agent",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

// Public, read-only shared meeting. No AppShell/auth — reachable by anyone with
// the unguessable share token.
// Route: /share/:token
export async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const meeting = await getPublicMeeting(token);

  if (!meeting) notFound();

  return <PublicMeetingView data={meeting} />;
}
