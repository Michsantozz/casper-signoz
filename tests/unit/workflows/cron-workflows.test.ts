import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Os dois workflows-cron de "safety net": auto-schedule (agenda bots p/ eventos
 * de calendário perdidos por webhook) e meeting-reconcile (reprocessa atas presas).
 * Ambos são wrappers finos: um único step que delega à lógica server. Testamos
 * que o step chama a função certa com os argumentos certos e repassa o resultado.
 *
 * A cadência do cron + concurrency:1 (serialização de ticks) é config declarativa
 * aplicada pelo @mastra/inngest e verificada via inngest-cli (functions .cron
 * registradas com o trigger correto); aqui isolamos só a lógica do step.
 */

const autoScheduleAll = vi.fn();
const reconcileStuckMeetings = vi.fn();
const sweepExpiredOAuthNonces = vi.fn();

vi.mock("@/server/recall/auto-schedule", () => ({
  autoScheduleAll: (...a: unknown[]) => autoScheduleAll(...a),
}));
vi.mock("@/server/recall/enrich", () => ({
  reconcileStuckMeetings: (...a: unknown[]) => reconcileStuckMeetings(...a),
}));
vi.mock("@/server/recall/oauth-state", () => ({
  sweepExpiredOAuthNonces: (...a: unknown[]) => sweepExpiredOAuthNonces(...a),
}));

function run(step: { execute: (p: never) => Promise<unknown> }) {
  return step.execute({ inputData: {} } as never);
}

beforeEach(() => {
  vi.resetModules();
  autoScheduleAll.mockReset();
  reconcileStuckMeetings.mockReset();
  sweepExpiredOAuthNonces.mockReset();
});

describe("workflow auto-schedule — step", () => {
  it("delega a autoScheduleAll e repassa as contagens", async () => {
    autoScheduleAll.mockResolvedValue({ calendars: 3, scheduled: 5 });
    const { scan } = await import("@/mastra/workflows/auto-schedule.workflow");

    const out = await run(scan);

    expect(autoScheduleAll).toHaveBeenCalledOnce();
    expect(out).toEqual({ calendars: 3, scheduled: 5 });
  });
});

describe("workflow meeting-reconcile — step", () => {
  it("varre com a janela de staleness de 15 min e repassa o resultado", async () => {
    reconcileStuckMeetings.mockResolvedValue({
      processed: 2,
      done: 1,
      stillPending: 1,
    });
    const { reconcile } = await import(
      "@/mastra/workflows/meeting-reconcile.workflow"
    );

    const out = await run(reconcile);

    // 15 min em ms (≈3× o cron, alinhado ao claim's staleProcessingMs) — evita
    // reprocessar uma enrichment ainda VIVA disparada pelo webhook.
    expect(reconcileStuckMeetings).toHaveBeenCalledWith(15 * 60_000);
    expect(out).toEqual({ processed: 2, done: 1, stillPending: 1 });
  });
});

describe("workflow oauth-nonce-sweep — step", () => {
  it("delega a sweepExpiredOAuthNonces e reporta as linhas removidas", async () => {
    sweepExpiredOAuthNonces.mockResolvedValue(4);
    const { oauthNonceSweep } = await import(
      "@/mastra/workflows/oauth-nonce-sweep.workflow"
    );

    const out = await run(oauthNonceSweep);

    expect(sweepExpiredOAuthNonces).toHaveBeenCalledOnce();
    expect(out).toEqual({ deleted: 4 });
  });
});
