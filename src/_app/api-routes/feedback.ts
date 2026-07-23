import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";

/**
 * Human feedback (👍/👎) on an assistant message. Routes into Mastra's
 * observability domain via `addFeedback`, which the MastraStorageExporter
 * persists (it implements `onFeedbackEvent`). This is the purpose-built home
 * for human feedback — separate from automatic LLM-judge scorers.
 *
 * We don't have a per-message traceId wired through the UIMessage stream yet, so
 * we correlate by messageId + threadId in `feedback.metadata`. `addFeedback` is
 * an OPTIONAL method on the entrypoint (NoOp when observability isn't
 * registered), so we call it defensively.
 *
 * Thin shell: auth gate + delegate to observability.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { messageId, threadId, type } = (await req.json()) as {
    messageId?: string;
    threadId?: string;
    type?: "positive" | "negative";
  };
  if (type !== "positive" && type !== "negative") {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  const { mastra } = await import("@/mastra");
  await mastra.observability.addFeedback?.({
    feedback: {
      feedbackType: "thumbs",
      value: type === "positive" ? "up" : "down",
      feedbackSource: "user",
      feedbackUserId: session.user.id,
      metadata: { messageId, threadId },
    },
  });

  return NextResponse.json({ ok: true });
}
