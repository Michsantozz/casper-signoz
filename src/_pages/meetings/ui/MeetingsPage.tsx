import { MeetingsList } from "@/features/meetings/ui/MeetingsList";
import { AppShell } from "@/features/auth/ui/AppShell";

// Meetings index: dense list of recorded meetings. Clicking a transcribed one
// opens the notebook at /meetings/[botId].
// Route: /meetings
export function MeetingsPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <MeetingsList />
    </div>
  );
}
