import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/agents/{agentId}/channels/{platform}/webhook — the thin bridge
 * (_app/api-routes/agent-channels.ts) that hands inbound platform webhooks to
 * Mastra's AgentChannels. Contract:
 *  - unknown agent (no AgentChannels entry) → 404, nothing dispatched;
 *  - known agent but no adapter for that platform → 404;
 *  - adapter present → delegates to handleWebhookEvent(platform, req, {waitUntil})
 *    and returns its Response verbatim; the raw Request is passed through
 *    untouched so the adapter can verify the Slack signature itself.
 *
 * @/mastra is dynamically imported in the handler, so we mock getChannels — no
 * real Mastra boot, no LLM, no db. next/server's `after` is stubbed to run the
 * task inline.
 */

const getChannels = vi.fn();
const handleWebhookEvent = vi.fn();
const hasAdapter = vi.fn();

vi.mock("@/mastra", () => ({
  mastra: { getChannels: () => getChannels() },
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => fn() };
});

async function post(agentId: string, platform: string): Promise<Response> {
  const { POST } = await import("@/_app/api-routes/agent-channels");
  const url = `http://x/api/agents/${agentId}/channels/${platform}/webhook`;
  return POST(new Request(url, { method: "POST", body: "{}" }), {
    params: Promise.resolve({ agentId, platform }),
  });
}

beforeEach(() => {
  vi.resetModules();
  getChannels.mockReset();
  handleWebhookEvent.mockReset();
  hasAdapter.mockReset();
});

describe("POST agent-channels — routing guard", () => {
  it("unknown agent → 404, nothing dispatched", async () => {
    getChannels.mockReturnValue({}); // no entry for sreAgent
    const res = await post("sreAgent", "slack");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "channel_not_configured",
      agentId: "sreAgent",
      platform: "slack",
    });
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });

  it("known agent but platform not wired → 404", async () => {
    hasAdapter.mockReturnValue(false);
    getChannels.mockReturnValue({ sreAgent: { hasAdapter, handleWebhookEvent } });
    const res = await post("sreAgent", "discord");
    expect(res.status).toBe(404);
    expect(hasAdapter).toHaveBeenCalledWith("discord");
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("POST agent-channels — delegation", () => {
  it("adapter present → delegates and returns the handler Response verbatim", async () => {
    const handlerResponse = new Response("ok", { status: 200 });
    hasAdapter.mockReturnValue(true);
    handleWebhookEvent.mockResolvedValue(handlerResponse);
    getChannels.mockReturnValue({ sreAgent: { hasAdapter, handleWebhookEvent } });

    const res = await post("sreAgent", "slack");

    expect(res).toBe(handlerResponse);
    expect(res.status).toBe(200);
    expect(hasAdapter).toHaveBeenCalledWith("slack");
    // Delegated with the platform, the raw Request, and a waitUntil bridge.
    expect(handleWebhookEvent).toHaveBeenCalledTimes(1);
    const [platform, req, options] = handleWebhookEvent.mock.calls[0];
    expect(platform).toBe("slack");
    expect(req).toBeInstanceOf(Request);
    expect(typeof options.waitUntil).toBe("function");
  });

  it("passes the raw request body through untouched (adapter verifies signature)", async () => {
    hasAdapter.mockReturnValue(true);
    handleWebhookEvent.mockResolvedValue(new Response(null, { status: 200 }));
    getChannels.mockReturnValue({ sreAgent: { hasAdapter, handleWebhookEvent } });

    await post("sreAgent", "slack");

    const [, req] = handleWebhookEvent.mock.calls[0];
    expect(await (req as Request).text()).toBe("{}");
  });
});
