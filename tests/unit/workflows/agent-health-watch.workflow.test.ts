import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * agent-health-watch cron workflow — the self-observing loop as a scheduled job.
 * Thin wrapper: a single step that delegates to runAgentHealthWatch and passes
 * the result straight through. Same shape as the other cron steps
 * (cron-workflows.test.ts). We isolate the step's execute here; the cron cadence
 * (every 15 min) + concurrency:1 is declarative config applied by @mastra/inngest.
 */

const runAgentHealthWatch = vi.fn();
vi.mock("@/server/observability/agent-health-watch", () => ({
  runAgentHealthWatch: (...a: unknown[]) => runAgentHealthWatch(...a),
}));

beforeEach(() => {
  vi.resetModules();
  runAgentHealthWatch.mockReset();
});

describe("workflow agent-health-watch — step", () => {
  it("delegates to runAgentHealthWatch and passes the result through", async () => {
    runAgentHealthWatch.mockResolvedValue({
      ran: true,
      summary: "healthy",
      notified: 3,
    });
    const { agentHealthWatch } = await import(
      "@/mastra/workflows/agent-health-watch.workflow"
    );

    const out = await agentHealthWatch.execute({ inputData: {} } as never);

    // The cron pass runs with default notify (fans out) — no dry-run override.
    expect(runAgentHealthWatch).toHaveBeenCalledOnce();
    expect(out).toEqual({ ran: true, summary: "healthy", notified: 3 });
  });
});
