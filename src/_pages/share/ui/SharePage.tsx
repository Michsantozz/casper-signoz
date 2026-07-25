import type { Metadata } from "next";
import { notFound } from "next/navigation";
// Deep import on purpose, NOT through the slice barrel. `@/features/meetings`
// re-exports the whole slice (MeetingNotebook, MeetingsList, TeamTrends, the
// tool UIs), and pulling the barrel in here dragged all of it into this route's
// client bundle: /share/[token] went 878 KiB -> 2118 KiB, 2.4x over budget.
// This page renders exactly one component; importing exactly one component
// keeps the public share route small.
import { PublicMeetingView } from "@/features/meetings/ui/PublicMeetingView";
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
