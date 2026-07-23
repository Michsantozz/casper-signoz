import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import {
  renameThread,
  setArchived,
  deleteThread,
} from "@/features/assistant/model/threads";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mutations on a single chat thread (rename / archive / delete). Maps the
 * ThreadList sidebar actions to the Mastra memory thread. Ownership is enforced
 * in the thread store — a thread owned by another user 404s here.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json()) as { title?: string; archived?: boolean };

  try {
    if (typeof body.title === "string") {
      await renameThread(session.user.id, id, body.title);
    }
    if (typeof body.archived === "boolean") {
      await setArchived(session.user.id, id, body.archived);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "thread not found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  try {
    await deleteThread(session.user.id, id);
  } catch (err) {
    if (err instanceof Error && err.message === "thread not found") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
