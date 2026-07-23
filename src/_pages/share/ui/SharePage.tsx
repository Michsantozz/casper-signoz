import { PublicMeetingView } from "@/features/meetings/ui/PublicMeetingView";
import type { PublicMeetingResponse } from "@/features/meetings/model/queries";

// Public, read-only shared meeting. No AppShell/auth — reachable by anyone with
// the unguessable share token.
// Route: /share/:token
export function SharePage({ meeting }: { meeting: PublicMeetingResponse }) {
  return <PublicMeetingView data={meeting} />;
}
