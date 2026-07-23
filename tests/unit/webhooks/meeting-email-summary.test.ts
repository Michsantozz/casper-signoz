import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * POST /api/meetings/[botId]/email-summary — endpoint de AÇÃO por trás do botão
 * confirm_send_summary_email. O envio ocorre num clique humano aqui, nunca por
 * decisão do LLM. Cobrimos as bordas da rota:
 *
 *  - CSRF: Origin cross-site → 403 (assertSameOrigin real, headers mockados).
 *  - auth: sem sessão → 401, sem tocar a lógica de envio.
 *  - validação: body sem email válido → 400.
 *  - mapeamento de resultado: rate_limited → 429; not_ready/no_summary → 400;
 *    ok → 200 com { to, meetingTitle }.
 *  - dono errado: shareMeetingSummary lança → 500 genérico (não revela existência).
 */

const getSession = vi.fn();
const shareMeetingSummary = vi.fn();
const headersGet = vi.fn();

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/share-summary", () => ({
  shareMeetingSummary: (...a: unknown[]) => shareMeetingSummary(...a),
}));
// next/headers usado por assertSameOrigin (http.ts real).
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headersGet(k) }),
}));

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/meetings/bot-1/email-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ botId: "bot-1" });

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset().mockResolvedValue({ user: { id: "u1" } });
  shareMeetingSummary.mockReset();
  // Default: same-origin (Origin === host) → passa o CSRF.
  headersGet.mockReset().mockImplementation((k: string) =>
    k === "origin" ? "http://localhost" : k === "host" ? "localhost" : null,
  );
});

describe("POST email-summary — bordas de segurança", () => {
  it("Origin cross-site → 403 e não envia", async () => {
    headersGet.mockImplementation((k: string) =>
      k === "origin" ? "http://evil.com" : k === "host" ? "localhost" : null,
    );
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(403);
    expect(shareMeetingSummary).not.toHaveBeenCalled();
  });

  it("sem sessão → 401", async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(401);
    expect(shareMeetingSummary).not.toHaveBeenCalled();
  });

  it("email inválido no body → 400", async () => {
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "not-an-email" }), { params });
    expect(res.status).toBe(400);
    expect(shareMeetingSummary).not.toHaveBeenCalled();
  });
});

describe("POST email-summary — mapeamento de resultado", () => {
  it("sucesso → 200 com { to, meetingTitle }", async () => {
    shareMeetingSummary.mockResolvedValue({
      ok: true,
      to: "boss@x.com",
      meetingTitle: "meet.google.com/abc",
    });
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "boss@x.com" }), { params });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      to: string;
      meetingTitle: string;
    };
    expect(json).toEqual({
      ok: true,
      to: "boss@x.com",
      meetingTitle: "meet.google.com/abc",
    });
    // userId vem da SESSÃO, nunca do body.
    expect(shareMeetingSummary).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-1", userId: "u1", to: "boss@x.com" }),
    );
  });

  it("rate_limited → 429 com Retry-After", async () => {
    shareMeetingSummary.mockResolvedValue({
      ok: false,
      reason: "rate_limited",
      retryAfter: 1800,
    });
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
  });

  it("not_ready → 400", async () => {
    shareMeetingSummary.mockResolvedValue({ ok: false, reason: "not_ready" });
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(400);
  });

  it("no_summary → 400", async () => {
    shareMeetingSummary.mockResolvedValue({ ok: false, reason: "no_summary" });
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(400);
  });

  it("dono errado (share lança) → 500 genérico", async () => {
    shareMeetingSummary.mockRejectedValue(new Error("Meeting bot-1 not found"));
    const { POST } = await import("@/app/api/meetings/[botId]/email-summary/route");
    const res = await POST(makeRequest({ to: "a@b.com" }), { params });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("send_failed");
    // Não vaza a mensagem interna (existência do bot).
    expect(JSON.stringify(json)).not.toContain("not found");
  });
});
