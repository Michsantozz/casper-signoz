import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { getThreadMessages } from "@/features/assistant/model/threads";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Message history for a thread, as AI SDK v6 UIMessages — assistant-ui hydrates
 * this into the runtime when the user switches to the thread. `recall`
 * validates resourceId, so this can't return another user's messages.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const messages = await getThreadMessages(session.user.id, id);
  return NextResponse.json({ messages });
}
