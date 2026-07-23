import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharePage } from "@/_pages/share";
import { getPublicMeeting } from "@/server/recall/public-meeting";

export const metadata: Metadata = {
  title: "Shared meeting | Casper Agent",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const meeting = await getPublicMeeting(token);

  if (!meeting) notFound();

  return <SharePage meeting={meeting} />;
}
