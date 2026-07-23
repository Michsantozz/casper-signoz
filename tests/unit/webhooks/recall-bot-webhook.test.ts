import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Webhook } from "svix";

/**
 * Webhook de BOT do Recall (/api/webhooks/recall/bot) — fecha o loop pós-reunião.
 * Cobrimos a borda de segurança (gate Svix, mesma cripto do runtime) E a máquina
 * de reação: só transcript.done enfileira a ata + DISPARA o workflow durável
 * meeting-enrich via inngest.send (não bloqueia no LLM); outros eventos são ack
 * sem efeito. Dono resolvido por metadata do payload OU pelo repo.
 *
 * Libs server-only (repo/enqueue/RLS) + o client Inngest são mockadas p/ isolar a rota.
 */

const findBotByBotId = vi.fn();
const botOwnerUserId = vi.fn();
const enqueueMeetingRecord = vi.fn();
const inngestSend = vi.fn();

vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  botOwnerUserId: (...a: unknown[]) => botOwnerUserId(...a),
  resolveBotOwner: (row: unknown, supplied: unknown) => {
    const persisted = botOwnerUserId(row);
    if (persisted && typeof supplied === "string" && persisted !== supplied) {
      return { userId: null, conflict: true };
    }
    return {
      userId: persisted ?? (typeof supplied === "string" ? supplied : null),
      conflict: false,
    };
  },
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  enqueueMeetingRecord: (...a: unknown[]) => enqueueMeetingRecord(...a),
}));
vi.mock("@/inngest/client", () => ({
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}));
vi.mock("@/shared/db/rls", () => ({
  withSystemScope: (fn: () => unknown) => fn(),
}));

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ORIGINAL = { ...process.env };

function makeRequest(body: unknown, opts?: { sign?: boolean; secret?: string }) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.sign ?? true) {
    const id = "msg_test";
    const timestamp = new Date();
    const signature = new Webhook(opts?.secret ?? SECRET).sign(id, timestamp, raw);
    headers["svix-id"] = id;
    headers["svix-timestamp"] = Math.floor(timestamp.getTime() / 1000).toString();
    headers["svix-signature"] = signature;
  }
  return new Request("http://localhost/api/webhooks/recall/bot", {
    method: "POST",
    headers,
    body: raw,
  });
}

beforeEach(() => {
  vi.resetModules();
  findBotByBotId.mockReset();
  botOwnerUserId.mockReset();
  enqueueMeetingRecord.mockReset();
  inngestSend.mockReset();
  process.env.RECALL_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("POST /api/webhooks/recall/bot — gate Svix", () => {
  it("rejeita assinatura inválida com 401 e não processa", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest(
        { event: "transcript.done", data: { bot: { id: "bot-1" } } },
        { secret: "whsec_00000000000000000000000000000000" },
      ),
    );
    expect(res.status).toBe(401);
    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
  });

  it("rejeita sem headers Svix com 401", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest(
        { event: "transcript.done", data: { bot: { id: "bot-1" } } },
        { sign: false },
      ),
    );
    expect(res.status).toBe(401);
    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
  });

  it("fail-closed: sem RECALL_WEBHOOK_SECRET → 500 e não processa", async () => {
    delete process.env.RECALL_WEBHOOK_SECRET;
    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({ event: "transcript.done", data: { bot: { id: "bot-1" } } }),
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("webhook_not_configured");
    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/recall/bot — reação por evento", () => {
  it("transcript.done: enfileira a ata e dispara o workflow meeting-enrich (200)", async () => {
    findBotByBotId.mockResolvedValue({ meetingUrl: "https://meet/x" });
    botOwnerUserId.mockReturnValue("owner-1");
    enqueueMeetingRecord.mockResolvedValue(undefined);
    inngestSend.mockResolvedValue({ ids: ["evt-1"] });

    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({ event: "transcript.done", data: { bot: { id: "bot-9" } } }),
    );

    expect(res.status).toBe(200);
    expect(enqueueMeetingRecord).toHaveBeenCalledWith({
      botId: "bot-9",
      userId: "owner-1",
      meetingUrl: "https://meet/x",
    });
    // Dispara o evento do workflow durável com o shape que @mastra/inngest espera.
    expect(inngestSend).toHaveBeenCalledWith({
      name: "workflow.meeting-enrich",
      data: { inputData: { botId: "bot-9" } },
    });
    const json = (await res.json()) as { dispatched: string };
    expect(json.dispatched).toBe("meeting-enrich");
  });

  it("quarantines conflicting payload and persisted owners", async () => {
    findBotByBotId.mockResolvedValue({ meetingUrl: null });
    botOwnerUserId.mockReturnValue("owner-repo");
    enqueueMeetingRecord.mockResolvedValue(undefined);
    inngestSend.mockResolvedValue({ ids: ["evt-1"] });

    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({
        event: "transcript.done",
        data: { bot: { id: "bot-9", metadata: { user_id: "owner-payload" } } },
      }),
    );

    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ quarantined: "owner_mismatch" });
  });

  it("send do evento que rejeita não vira 5xx (fica pending p/ reconcile)", async () => {
    findBotByBotId.mockResolvedValue({ meetingUrl: null });
    botOwnerUserId.mockReturnValue("owner-1");
    enqueueMeetingRecord.mockResolvedValue(undefined);
    // Falha ao despachar o evento: a rota engole (o cron reconcile é a rede de
    // segurança), a ata já está pending, e NÃO deve retornar 5xx.
    inngestSend.mockRejectedValue(new Error("inngest unreachable"));

    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({ event: "transcript.done", data: { bot: { id: "bot-9" } } }),
    );

    expect(res.status).toBe(200);
    expect(enqueueMeetingRecord).toHaveBeenCalled();
    const json = (await res.json()) as { dispatched: string };
    expect(json.dispatched).toBe("meeting-enrich");
  });

  it("transcript.done sem bot id: ack sem enfileirar", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({ event: "transcript.done", data: { bot: {} } }),
    );
    expect(res.status).toBe(200);
    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
  });

  it("evento não-transcript (bot.done) é ack sem efeito", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/bot/route");
    const res = await POST(
      makeRequest({ event: "bot.done", data: { bot: { id: "bot-9" } } }),
    );
    expect(res.status).toBe(200);
    expect(enqueueMeetingRecord).not.toHaveBeenCalled();
    const json = (await res.json()) as { ignored: string };
    expect(json.ignored).toBe("bot.done");
  });
});
