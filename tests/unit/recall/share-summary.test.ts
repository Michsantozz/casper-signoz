import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * shareMeetingSummary (server/recall/share-summary.ts) — ponte por trás do envio
 * de ata por e-mail a um destinatário livre. Garantias:
 *
 *  1. ownership: assertBotOwner é chamado ANTES de qualquer trabalho; se lança,
 *     nada é enviado (o dono errado não vaza a ata de outrem).
 *  2. anti-spam: rate limit por usuário; estourado → { ok:false, rate_limited }
 *     e NÃO envia.
 *  3. durable-first: usa a ata persistida (sem custo de LLM); só summariza on
 *     demand quando o record não tem summary.
 *  4. estados: transcript ainda processando → not_ready; sem summary → no_summary.
 *  5. sucesso: envia via emailMeetingSummaryToRecipient com senderName resolvido
 *     e título derivado do meetingUrl.
 *
 * Todas as libs server-only são mockadas para isolar a orquestração.
 */

const assertBotOwner = vi.fn();
const findMeetingRecord = vi.fn();
const summarizeMeeting = vi.fn();
const emailToRecipient = vi.fn();
const userIdentityById = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/server/recall/ownership", () => ({
  assertBotOwner: (...a: unknown[]) => assertBotOwner(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  findMeetingRecord: (...a: unknown[]) => findMeetingRecord(...a),
}));
vi.mock("@/server/recall/summarize", () => ({
  summarizeMeeting: (...a: unknown[]) => summarizeMeeting(...a),
}));
vi.mock("@/server/email", () => ({
  emailMeetingSummaryToRecipient: (...a: unknown[]) => emailToRecipient(...a),
  userIdentityById: (...a: unknown[]) => userIdentityById(...a),
}));
vi.mock("@/shared/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (_userId: string, fn: () => unknown) => fn(),
}));

const OK_RL = { ok: true, count: 1, retryAfter: 3600 };

beforeEach(() => {
  vi.resetModules();
  assertBotOwner.mockReset().mockResolvedValue(undefined);
  findMeetingRecord.mockReset();
  summarizeMeeting.mockReset();
  emailToRecipient.mockReset().mockResolvedValue(undefined);
  userIdentityById.mockReset().mockResolvedValue({ name: "Ana", email: "ana@x.com" });
  checkRateLimit.mockReset().mockResolvedValue(OK_RL);
});

async function run(over: Partial<Parameters<
  typeof import("@/server/recall/share-summary").shareMeetingSummary
>[0]> = {}) {
  const { shareMeetingSummary } = await import("@/server/recall/share-summary");
  return shareMeetingSummary({
    botId: "bot-1",
    userId: "u1",
    to: "boss@empresa.com",
    ...over,
  });
}

describe("shareMeetingSummary — ownership", () => {
  it("checa ownership antes de tudo; se lança, não envia", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    await expect(run()).rejects.toThrow(/not accessible/);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(emailToRecipient).not.toHaveBeenCalled();
  });
});

describe("shareMeetingSummary — rate limit (anti-spam)", () => {
  it("estourado → { ok:false, rate_limited } e não envia", async () => {
    checkRateLimit.mockResolvedValue({ ok: false, count: 11, retryAfter: 1800 });
    const res = await run();
    expect(res).toEqual({ ok: false, reason: "rate_limited", retryAfter: 1800 });
    expect(emailToRecipient).not.toHaveBeenCalled();
  });

  it("usa chave namespaced por usuário", async () => {
    findMeetingRecord.mockResolvedValue({ summary: "s", meetingUrl: null });
    await run({ userId: "user-42" });
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "share_summary:user-42" }),
    );
  });
});

describe("shareMeetingSummary — durable-first", () => {
  it("usa a ata persistida sem chamar o LLM", async () => {
    findMeetingRecord.mockResolvedValue({
      summary: "Resumo salvo.",
      overview: "Overview.",
      decisions: ["D1"],
      actionItems: [{ task: "T1", owner: null }],
      topics: ["Tópico"],
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
    const res = await run();
    expect(summarizeMeeting).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      to: "boss@empresa.com",
      meetingTitle: "meet.google.com/abc-defg-hij",
    });
    expect(emailToRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "boss@empresa.com",
        senderName: "Ana",
        content: expect.objectContaining({ summary: "Resumo salvo." }),
      }),
    );
  });

  it("sem summary persistido, summariza on demand e envia", async () => {
    findMeetingRecord.mockResolvedValue({ summary: null, meetingUrl: null });
    summarizeMeeting.mockResolvedValue({
      state: "ready",
      summary: "Resumo LLM.",
      decisions: [],
      actionItems: [],
      topics: [],
    });
    const res = await run();
    expect(summarizeMeeting).toHaveBeenCalledWith("bot-1");
    expect(res).toMatchObject({ ok: true });
    expect(emailToRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ summary: "Resumo LLM." }),
      }),
    );
  });
});

describe("shareMeetingSummary — summary indisponível", () => {
  it("transcript ainda processando → not_ready, não envia", async () => {
    findMeetingRecord.mockResolvedValue(null);
    summarizeMeeting.mockResolvedValue({ state: "processing", summary: null });
    const res = await run();
    expect(res).toEqual({ ok: false, reason: "not_ready" });
    expect(emailToRecipient).not.toHaveBeenCalled();
  });

  it("sem summary gerado → no_summary, não envia", async () => {
    findMeetingRecord.mockResolvedValue(null);
    summarizeMeeting.mockResolvedValue({ state: "none", summary: null });
    const res = await run();
    expect(res).toEqual({ ok: false, reason: "no_summary" });
    expect(emailToRecipient).not.toHaveBeenCalled();
  });
});

describe("shareMeetingSummary — sender e título", () => {
  it("sem nome no perfil, usa o email como senderName", async () => {
    userIdentityById.mockResolvedValue({ name: null, email: "ana@x.com" });
    findMeetingRecord.mockResolvedValue({ summary: "s", meetingUrl: null });
    await run();
    expect(emailToRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ senderName: "ana@x.com" }),
    );
  });

  it("meetingUrl ausente → título de fallback 'your meeting'", async () => {
    findMeetingRecord.mockResolvedValue({ summary: "s", meetingUrl: null });
    const res = await run();
    expect(res).toMatchObject({ ok: true, meetingTitle: "your meeting" });
  });

  it("nota do remetente é repassada ao template", async () => {
    findMeetingRecord.mockResolvedValue({ summary: "s", meetingUrl: null });
    await run({ note: "para o chefe" });
    expect(emailToRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ note: "para o chefe" }),
    );
  });
});
