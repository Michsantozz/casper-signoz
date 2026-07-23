import { MeetingNotebook } from "@/features/meetings/ui/MeetingNotebook";
import { AppShell } from "@/features/auth/ui/AppShell";

// Meeting notebook: terminal-aesthetic minutes (player + karaoke transcript +
// AI panels) on the left, the real assistant Thread on the right.
// Route: /meetings/:botId
export async function MeetingNotebookPage({
  params,
}: {
  params: Promise<{ botId: string }>;
}) {
  const { botId } = await params;
  return (
    <>
      <AppShell />
      <MeetingNotebook botId={botId} />
    </>
  );
}
