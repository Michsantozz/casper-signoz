import { sql } from "drizzle-orm";
import { db } from "@/shared/db";

/**
 * Liveness + readiness in a single endpoint.
 *
 * - Liveness: if this handler responds, the Node process is alive.
 * - Readiness: `?ready=1` (or `?deep=1`) also pings Postgres with `SELECT 1`.
 *   Without the dependency up, returns 503 → orchestrator won't route traffic to the pod.
 *
 * Probe liveness with `GET /api/health` (fast, no external I/O) and readiness
 * with `GET /api/health?ready=1`. Separating them avoids a slow DB taking down
 * the pod via a liveness failure (restart loop) when it's only temporarily not-ready.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep =
    url.searchParams.has("ready") || url.searchParams.has("deep");

  if (!deep) {
    return Response.json({ status: "ok" });
  }

  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", db: "up" });
  } catch {
    // Don't leak error detail (message/host) in the public response.
    return Response.json({ status: "error", db: "down" }, { status: 503 });
  }
}
