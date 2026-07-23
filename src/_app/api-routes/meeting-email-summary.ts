import { z } from "zod";
import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { shareMeetingSummary } from "@/server/recall/share-summary";
import { assertSameOrigin, parseBody } from "@/shared/lib/http";
import {
  badRequest,
  serverError,
  unauthorized,
} from "@/shared/lib/api-error";
import { rateLimitedResponse } from "@/shared/lib/rate-limit";

/**
 * POST /api/meetings/[botId]/email-summary
 *
 * Emails a meeting's minutes to an arbitrary recipient chosen by the owner. This
 * is the ACTION endpoint behind the chat's confirm_send_summary_email button:
 * the send happens on an explicit human click here, NOT on the LLM's decision —
 * so the model can never fire an email on its own. Ownership, rate limit, and
 * durable-first summary reuse all live in shareMeetingSummary.
 */
const bodySchema = z.object({
  to: z.email(),
  note: z.string().trim().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const session = await getSession();
  if (!session?.user?.id) return unauthorized();

  const { data, response } = await parseBody(req, bodySchema);
  if (response) return response;

  const { botId } = await params;

  try {
    const result = await shareMeetingSummary({
      botId,
      userId: session.user.id,
      to: data.to,
      note: data.note,
    });

    if (!result.ok) {
      if (result.reason === "rate_limited") {
        return rateLimitedResponse(result.retryAfter ?? 60);
      }
      // Summary not available yet (still processing / no transcript).
      return badRequest(result.reason);
    }

    return NextResponse.json({
      ok: true,
      to: result.to,
      meetingTitle: result.meetingTitle,
    });
  } catch (err) {
    // assertBotOwner throws for a non-owned/unknown bot — 404-equivalent, but
    // shaped as a generic failure so it doesn't reveal whether the bot exists.
    return serverError("meeting-email-summary", err, "send_failed");
  }
}
