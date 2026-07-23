import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { listDynamicsForUser } from "@/server/recall/meeting-repository";
import { computeTeamTrends } from "@/server/recall/dynamics-trends";
import { withUserScope } from "@/shared/db/rls";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";

/**
 * Longitudinal team-health trends for the /meetings/trends page. Aggregates the
 * caller's persisted dynamics snapshots into per-person trajectories + a team
 * balance series + actionable signals. RLS-scoped to the session user.
 *
 * Thin shell: delegates to the repository + the pure computeTeamTrends engine.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // Aggregation over up to 200 snapshots is unbounded per-request cost — throttle.
  const rl = await checkRateLimit({
    key: `team-trends:${userId}`,
    window: 60,
    max: 60,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 3 ? Math.min(rawLimit, 200) : 50;

  const snapshots = await withUserScope(userId, () =>
    listDynamicsForUser(limit),
  );
  const trends = computeTeamTrends(snapshots);

  // Not enough meetings with dynamics yet — the UI shows an empty state.
  return NextResponse.json({
    available: trends != null,
    meetingsWithDynamics: snapshots.length,
    trends,
  });
}
