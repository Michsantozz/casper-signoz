import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Webhook } from "svix";

/**
 * Webhook do Recall (H-4): verificação de assinatura Svix antes de processar.
 * Mockamos as libs server-only de calendar (tocam DB/Recall) para isolar a
 * borda de segurança — o que testamos aqui é o gate de assinatura, não o efeito.
 * A assinatura é gerada com o próprio SDK Svix (mesma cripto do runtime).
 */

const retrieveCalendar = vi.fn();
const findCalendarById = vi.fn();
const updateCalendarStatus = vi.fn();

vi.mock("@/server/recall/calendars", () => ({
  retrieveCalendar: (...a: unknown[]) => retrieveCalendar(...a),
}));
vi.mock("@/server/recall/calendar-repository", () => ({
  findCalendarById: (...a: unknown[]) => findCalendarById(...a),
  updateCalendarStatus: (...a: unknown[]) => updateCalendarStatus(...a),
}));
// RLS: withSystemScope só executa o callback (sem abrir transação PG real no teste).
vi.mock("@/shared/db/rls", () => ({
  withSystemScope: (fn: () => unknown) => fn(),
  withUserScope: (_u: string, fn: () => unknown) => fn(),
  scopedDb: () => {
    throw new Error("scopedDb not available in this unit test");
  },
}));
// auto-schedule toca Recall; o gate de sync_events é out-of-scope aqui.
const autoScheduleForCalendar = vi.fn();
vi.mock("@/server/recall/auto-schedule", () => ({
  autoScheduleForCalendar: (...a: unknown[]) => autoScheduleForCalendar(...a),
}));

// Secret de teste no formato Svix (whsec_ + base64).
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ORIGINAL = { ...process.env };

/** Monta um Request com corpo cru + headers Svix assinados (ou não). */
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
  return new Request("http://localhost/api/webhooks/recall", {
    method: "POST",
    headers,
    body: raw,
  });
}

beforeEach(() => {
  vi.resetModules();
  retrieveCalendar.mockReset();
  findCalendarById.mockReset();
  updateCalendarStatus.mockReset();
  process.env.RECALL_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("POST /api/webhooks/recall — gate de assinatura Svix", () => {
  it("aceita e processa payload com assinatura válida (200)", async () => {
    findCalendarById.mockResolvedValue({ recallCalendarId: "cal-1" });
    retrieveCalendar.mockResolvedValue({ status: "disconnected" });

    const { POST } = await import("@/app/api/webhooks/recall/route");
    const res = await POST(
      makeRequest({ event: "calendar.update", data: { calendar_id: "cal-1" } }),
    );

    expect(res.status).toBe(200);
    expect(findCalendarById).toHaveBeenCalledWith("cal-1");
    expect(updateCalendarStatus).toHaveBeenCalledWith("cal-1", "disconnected");
  });

  it("rejeita assinatura inválida com 401 e NÃO processa", async () => {
    // Assinado com secret errado → verify falha.
    const { POST } = await import("@/app/api/webhooks/recall/route");
    const res = await POST(
      makeRequest(
        { event: "calendar.update", data: { calendar_id: "cal-1" } },
        { secret: "whsec_00000000000000000000000000000000" },
      ),
    );

    expect(res.status).toBe(401);
    expect(findCalendarById).not.toHaveBeenCalled();
  });

  it("rejeita request sem headers Svix com 401", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/route");
    const res = await POST(
      makeRequest(
        { event: "calendar.update", data: { calendar_id: "cal-1" } },
        { sign: false },
      ),
    );

    expect(res.status).toBe(401);
    expect(findCalendarById).not.toHaveBeenCalled();
  });

  it("fail-closed: sem RECALL_WEBHOOK_SECRET retorna 500 e não processa", async () => {
    delete process.env.RECALL_WEBHOOK_SECRET;
    const { POST } = await import("@/app/api/webhooks/recall/route");
    const res = await POST(
      makeRequest({ event: "calendar.update", data: { calendar_id: "cal-1" } }),
    );

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("webhook_not_configured");
    expect(findCalendarById).not.toHaveBeenCalled();
  });

  it("evento desconhecido com assinatura válida é ack (200) sem efeito", async () => {
    const { POST } = await import("@/app/api/webhooks/recall/route");
    const res = await POST(
      makeRequest({ event: "calendar.unknown", data: {} }),
    );

    expect(res.status).toBe(200);
    expect(findCalendarById).not.toHaveBeenCalled();
  });
});
