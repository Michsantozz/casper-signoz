import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Workflow meeting-enrich (event-driven) — o step fino que a rota do webhook
 * dispara via inngest.send. Testamos a LÓGICA do step isoladamente: chama
 * enrichMeeting(botId) e projeta o resultado no output { state }. A engine do
 * Inngest (trigger de evento, concurrency, durabilidade) é responsabilidade do
 * @mastra/inngest e já foi verificada end-to-end contra o inngest-cli.
 *
 * enrichMeeting é server-only (LLM/DB): mockado para isolar o mapeamento.
 */

const enrichMeeting = vi.fn();

vi.mock("@/server/recall/enrich", () => ({
  enrichMeeting: (...a: unknown[]) => enrichMeeting(...a),
}));

// O step só usa inputData; o resto do ExecuteFunctionParams é opcional em runtime.
// Cast: a assinatura completa exige campos de observabilidade que o step ignora.
function run(step: { execute: (p: never) => Promise<unknown> }, botId: string) {
  return step.execute({ inputData: { botId } } as never);
}

beforeEach(() => {
  vi.resetModules();
  enrichMeeting.mockReset();
});

describe("workflow meeting-enrich — step", () => {
  it("chama enrichMeeting com o botId do inputData", async () => {
    enrichMeeting.mockResolvedValue({ state: "done", notified: true });
    const { enrich } = await import("@/mastra/workflows/meeting-enrich.workflow");

    await run(enrich, "bot-42");

    expect(enrichMeeting).toHaveBeenCalledWith("bot-42");
  });

  it("projeta o state do resultado no output", async () => {
    enrichMeeting.mockResolvedValue({ state: "skipped", reason: "already done" });
    const { enrich } = await import("@/mastra/workflows/meeting-enrich.workflow");

    const out = await run(enrich, "bot-42");

    expect(out).toEqual({ state: "skipped" });
  });

  it("propaga cada estado terminal do enrich (done/processing/failed)", async () => {
    const { enrich } = await import("@/mastra/workflows/meeting-enrich.workflow");
    for (const state of ["done", "processing", "failed"] as const) {
      enrichMeeting.mockResolvedValue({ state });
      expect(await run(enrich, "b")).toEqual({ state });
    }
  });
});
