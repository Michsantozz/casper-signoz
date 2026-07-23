import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { generateThreadTitle } from "@/features/assistant/model/threads";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Generates and persists a short title for a chat thread from its opening
 * turns. Called by the ThreadList's RemoteThreadListAdapter.generateTitle when
 * assistant-ui asks a new conversation to name itself. Ownership is enforced in
 * the thread store (resourceId-scoped) — a thread owned by another user 404s.
 *
 * Returns `{ title }` (string) or `{ title: null }` when there's not enough
 * content yet, so the sidebar keeps the "New Chat" fallback.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const title = await generateThreadTitle(session.user.id, id);
    return NextResponse.json({ title });
  } catch (err) {
    if (err instanceof Error && err.message === "thread not found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
}
