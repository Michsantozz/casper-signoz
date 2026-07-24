import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/internal/agent-health-watch — manual trigger for the autonomous
 * health watch (_app/api-routes/agent-health-watch.ts). Contract:
 *  - no session → 401, watch NOT run (fail-closed; operational endpoint);
 *  - authed → runs one pass; default notify=true (fans out);
 *  - ?notify=0 → runs the pass with notify:false (dry demo run), no fan-out;
 *  - returns the runAgentHealthWatch result as JSON.
 *
 * session + the dynamically-imported observability module are mocked — no LLM,
 * no db.
 */

const getSession = vi.fn();
const runAgentHealthWatch = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/observability/agent-health-watch", () => ({
  runAgentHealthWatch: (...a: unknown[]) => runAgentHealthWatch(...a),
}));

async function post(url: string): Promise<Response> {
  const { POST } = await import("@/_app/api-routes/agent-health-watch");
  return POST(new Request(url, { method: "POST" }));
}

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  runAgentHealthWatch.mockReset();
  getSession.mockResolvedValue({ user: { id: "op-1" } });
  runAgentHealthWatch.mockResolvedValue({
    ran: true,
    summary: "ok",
    notified: 2,
  });
});

describe("POST agent-health-watch — auth gate", () => {
  it("no session → 401, watch not run", async () => {
    getSession.mockResolvedValue(null);
    const res = await post("http://x/api/internal/agent-health-watch");
    expect(res.status).toBe(401);
    expect(runAgentHealthWatch).not.toHaveBeenCalled();
  });

  it("session without user → 401", async () => {
    getSession.mockResolvedValue({ user: null });
    const res = await post("http://x/api/internal/agent-health-watch");
    expect(res.status).toBe(401);
    expect(runAgentHealthWatch).not.toHaveBeenCalled();
  });
});

describe("POST agent-health-watch — run", () => {
  it("authed default → runs with notify:true and returns the result", async () => {
    const res = await post("http://x/api/internal/agent-health-watch");
    expect(res.status).toBe(200);
    expect(runAgentHealthWatch).toHaveBeenCalledWith({ notify: true });
    expect(await res.json()).toEqual({ ran: true, summary: "ok", notified: 2 });
  });

  it("?notify=0 → dry run (notify:false, no fan-out)", async () => {
    await post("http://x/api/internal/agent-health-watch?notify=0");
    expect(runAgentHealthWatch).toHaveBeenCalledWith({ notify: false });
  });

  it("any other notify value → treated as truthy (notify:true)", async () => {
    await post("http://x/api/internal/agent-health-watch?notify=1");
    expect(runAgentHealthWatch).toHaveBeenCalledWith({ notify: true });
  });
});
