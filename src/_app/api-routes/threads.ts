import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { listThreads, createThread } from "@/features/assistant/model/threads";

/**
 * Chat threads for the authenticated user — powers the ThreadList sidebar.
 * These are the same Mastra memory threads the agent persists to, scoped to
 * the caller. Thin shell: auth gate + delegate to the assistant thread store.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const threads = await listThreads(session.user.id);
  return NextResponse.json({ threads });
}

/**
 * Creates (initializes) a thread with the client-provided id, so the
 * assistant-ui local id and the Mastra thread id are the same.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json()) as { id?: string; title?: string };
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  try {
    const thread = await createThread(session.user.id, body.id, body.title);
    return NextResponse.json({ thread });
  } catch (err) {
    if (err instanceof Error && err.message === "thread id conflict") {
      return NextResponse.json({ error: "thread id conflict" }, { status: 409 });
    }
    throw err;
  }
}
