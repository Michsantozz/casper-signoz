import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";

/**
 * Manual trigger for the autonomous agent-health watch.
 *
 * The watch normally runs on a 15-min cron (agent-health-watch.workflow.ts).
 * This endpoint runs one pass on demand — for a demo, or to check right now —
 * without waiting for the next tick. It drives the SAME logic the cron does
 * (runAgentHealthWatch): the sreAgent inspects the app's own SigNoz telemetry
 * and provisions an alert if warranted.
 *
 * Auth-gated to a signed-in session (this is an operational endpoint, not a
 * per-tenant one). `?notify=0` runs the pass and returns the summary WITHOUT
 * fanning out notifications — handy for a dry demo run.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const notify = url.searchParams.get("notify") !== "0";

  const { runAgentHealthWatch } = await import(
    "@/server/observability/agent-health-watch"
  );
  const result = await runAgentHealthWatch({ notify });
  return NextResponse.json(result);
}
