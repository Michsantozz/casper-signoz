import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Canal de e-mail transacional (server/email.ts). Duas garantias críticas:
 *
 *  1. Degradação graciosa: sem RESEND_API_KEY, sendEmail é no-op e NUNCA lança —
 *     não pode derrubar o webhook de bot.
 *  2. Com key, chama o SDK Resend com from/to/subject/html corretos; e se o SDK
 *     lançar, o erro é engolido (best-effort), sem propagar ao chamador.
 *
 * Mockamos `resend` (SDK) e `@/shared/db` (userEmailById) para isolar a lógica.
 */

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => send(...a) };
  },
}));

// db.select().from().where().limit() → linhas. Encadeamento fluente mockado.
const limit = vi.fn();
vi.mock("@/shared/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...a: unknown[]) => limit(...a),
        }),
      }),
    }),
  },
}));
vi.mock("@/shared/db/auth-schema", () => ({ user: { id: "id", email: "email" } }));

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  limit.mockReset();
  // Cache de cliente Resend vive em globalThis.__resend — zera entre testes.
  delete (globalThis as { __resend?: unknown }).__resend;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  delete (globalThis as { __resend?: unknown }).__resend;
});

describe("sendEmail — degradação graciosa sem RESEND_API_KEY", () => {
  it("é no-op (não chama o SDK) e não lança quando não há key", async () => {
    const { sendEmail } = await import("@/server/email");
    await expect(
      sendEmail({ to: "a@b.com", subject: "x", html: "<p>x</p>" }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendEmail — com RESEND_API_KEY", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("chama o SDK com from/to/subject/html", async () => {
    send.mockResolvedValue({ id: "email_1" });
    const { sendEmail } = await import("@/server/email");
    await sendEmail({ to: "dest@x.com", subject: "Assunto", html: "<b>oi</b>" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dest@x.com",
        subject: "Assunto",
        html: "<b>oi</b>",
      }),
    );
  });

  it("usa EMAIL_FROM quando definido, senão o sandbox onboarding@resend.dev", async () => {
    send.mockResolvedValue({ id: "email_1" });

    // 1ª chamada: sem EMAIL_FROM → sandbox.
    let mod = await import("@/server/email");
    await mod.sendEmail({ to: "a@b.com", subject: "s", html: "h" });
    expect(send.mock.calls[0][0].from).toContain("onboarding@resend.dev");

    // 2ª: com EMAIL_FROM. Reset de módulos + cache p/ novo cliente pegar a env.
    vi.resetModules();
    delete (globalThis as { __resend?: unknown }).__resend;
    send.mockReset();
    send.mockResolvedValue({ id: "email_2" });
    process.env.EMAIL_FROM = "CasperAgent <no-reply@ultraself.com.br>";
    mod = await import("@/server/email");
    await mod.sendEmail({ to: "a@b.com", subject: "s", html: "h" });
    expect(send.mock.calls[0][0].from).toBe(
      "CasperAgent <no-reply@ultraself.com.br>",
    );
  });

  it("engole erro do SDK (best-effort) sem propagar", async () => {
    send.mockRejectedValue(new Error("Resend 500"));
    const { sendEmail } = await import("@/server/email");
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", html: "h" }),
    ).resolves.toBeUndefined();
  });
});

describe("userEmailById", () => {
  it("retorna o e-mail quando a linha existe", async () => {
    limit.mockResolvedValue([{ email: "user@x.com" }]);
    const { userEmailById } = await import("@/server/email");
    expect(await userEmailById("u1")).toBe("user@x.com");
  });

  it("retorna null quando não há linha", async () => {
    limit.mockResolvedValue([]);
    const { userEmailById } = await import("@/server/email");
    expect(await userEmailById("nope")).toBeNull();
  });
});

describe("templates transacionais", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  it("emailMagicLink: assunto de acesso + link no HTML", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMagicLink } = await import("@/server/email");
    await emailMagicLink({ to: "a@b.com", url: "https://link/magic?token=abc" });
    const call = send.mock.calls[0][0];
    expect(call.subject).toMatch(/access link/i);
    expect(call.html).toContain("https://link/magic?token=abc");
  });

  it("emailResetPassword: assunto de reset + link no HTML", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailResetPassword } = await import("@/server/email");
    await emailResetPassword({ to: "a@b.com", url: "https://link/reset?t=1" });
    const call = send.mock.calls[0][0];
    expect(call.subject).toMatch(/reset password/i);
    expect(call.html).toContain("https://link/reset?t=1");
  });

  it("emailVerifyAccount: assunto de confirmação + link de verificação no HTML", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailVerifyAccount } = await import("@/server/email");
    await emailVerifyAccount({
      to: "novo@x.com",
      url: "https://link/verify?token=xyz",
    });
    const call = send.mock.calls[0][0];
    expect(call.to).toBe("novo@x.com");
    expect(call.subject).toMatch(/confirm your email/i);
    expect(call.html).toContain("https://link/verify?token=xyz");
  });

  it("emailMeetingSummaryReady: sem botId aponta para o índice /meetings", async () => {
    limit.mockResolvedValue([{ email: "owner@x.com" }]);
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryReady } = await import("@/server/email");
    await emailMeetingSummaryReady({ userId: "u1", detail: " (30 min)" });
    const call = send.mock.calls[0][0];
    expect(call.to).toBe("owner@x.com");
    expect(call.html).toContain("https://app.example.com/meetings");
  });

  it("emailMeetingSummaryReady: com botId faz deep-link para o notebook", async () => {
    limit.mockResolvedValue([{ email: "owner@x.com" }]);
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryReady } = await import("@/server/email");
    await emailMeetingSummaryReady({
      userId: "u1",
      detail: " (30 min)",
      botId: "bot-42",
    });
    const call = send.mock.calls[0][0];
    expect(call.html).toContain("https://app.example.com/meetings/bot-42");
  });

  it("emailMeetingSummaryReady: sem e-mail do dono, não envia", async () => {
    limit.mockResolvedValue([]);
    const { emailMeetingSummaryReady } = await import("@/server/email");
    await emailMeetingSummaryReady({ userId: "ghost", detail: "" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("userIdentityById", () => {
  it("retorna nome + email quando a linha existe", async () => {
    limit.mockResolvedValue([{ name: "Ana", email: "ana@x.com" }]);
    const { userIdentityById } = await import("@/server/email");
    expect(await userIdentityById("u1")).toEqual({
      name: "Ana",
      email: "ana@x.com",
    });
  });

  it("name null quando o usuário não tem nome", async () => {
    limit.mockResolvedValue([{ name: null, email: "no-name@x.com" }]);
    const { userIdentityById } = await import("@/server/email");
    expect(await userIdentityById("u1")).toEqual({
      name: null,
      email: "no-name@x.com",
    });
  });

  it("retorna null quando não há linha", async () => {
    limit.mockResolvedValue([]);
    const { userIdentityById } = await import("@/server/email");
    expect(await userIdentityById("nope")).toBeNull();
  });
});

describe("emailMeetingSummaryToRecipient", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  const content = {
    summary: "Resumo executivo.",
    overview: "Visão geral em prosa.",
    decisions: ["Adotar plano A"],
    actionItems: [
      { task: "Enviar proposta", owner: "João" },
      { task: "Revisar contrato", owner: null },
    ],
    topics: ["Orçamento", "Prazos"],
  };

  it("assunto nomeia quem compartilhou + o título da reunião", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryToRecipient } = await import("@/server/email");
    await emailMeetingSummaryToRecipient({
      to: "boss@empresa.com",
      senderName: "Ana Silva",
      meetingTitle: "meet.google.com/abc-defg",
      content,
    });
    const call = send.mock.calls[0][0];
    expect(call.to).toBe("boss@empresa.com");
    expect(call.subject).toContain("Ana Silva");
    expect(call.subject).toContain("meet.google.com/abc-defg");
  });

  it("corpo prioriza overview e renderiza decisões + action items + owner", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryToRecipient } = await import("@/server/email");
    await emailMeetingSummaryToRecipient({
      to: "boss@empresa.com",
      senderName: "Ana",
      meetingTitle: "call",
      content,
    });
    const html = send.mock.calls[0][0].html as string;
    expect(html).toContain("Visão geral em prosa.");
    expect(html).toContain("Adotar plano A");
    expect(html).toContain("Enviar proposta");
    expect(html).toContain("João"); // owner mencionado
    expect(html).toContain("Orçamento");
  });

  it("nota do remetente aparece no corpo quando fornecida", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryToRecipient } = await import("@/server/email");
    await emailMeetingSummaryToRecipient({
      to: "boss@empresa.com",
      senderName: "Ana",
      meetingTitle: "call",
      content: { summary: "s" },
      note: "Segue o resumo que pediu.",
    });
    expect(send.mock.calls[0][0].html).toContain(
      "Segue o resumo que pediu.",
    );
  });

  it("escapa HTML no conteúdo (anti-injeção no corpo do email)", async () => {
    send.mockResolvedValue({ id: "e" });
    const { emailMeetingSummaryToRecipient } = await import("@/server/email");
    await emailMeetingSummaryToRecipient({
      to: "boss@empresa.com",
      senderName: "Ana",
      meetingTitle: "call",
      content: { summary: "<script>alert(1)</script>" },
    });
    const html = send.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
