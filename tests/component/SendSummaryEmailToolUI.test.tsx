import type React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * SendSummaryEmailToolUI — card de confirmação para enviar a ata por e-mail.
 * Contrato garantido:
 *  - o envio só ocorre no clique em "Send" (POST /api/meetings/{botId}/email-summary);
 *  - email inválido bloqueia o envio (validação client antes do fetch);
 *  - sucesso mostra o card "summary sent" com o destinatário;
 *  - 429 mostra aviso de limite e NÃO marca como enviado;
 *  - "Cancel" encerra sem enviar;
 *  - result.sent já resolvido mostra o resumo, some o formulário.
 *
 * makeAssistantTool roda no top-level → mockamos @assistant-ui/react para o
 * import não exigir o runtime do assistant-ui em jsdom.
 */

vi.mock("@assistant-ui/react", () => ({
  makeAssistantTool: () => ({ __tool: true }),
}));

import { SendSummaryEmailCard } from "@/features/meetings/ui/SendSummaryEmailToolUI";

function props(over: Record<string, unknown> = {}): React.ComponentProps<
  typeof SendSummaryEmailCard
> {
  return {
    args: { botId: "bot-1" },
    result: undefined,
    toolCallId: "call-1",
    ...over,
  } as unknown as React.ComponentProps<typeof SendSummaryEmailCard>;
}

function mockFetch(status = 200, body: unknown = { ok: true }) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SendSummaryEmailCard — formulário", () => {
  it("pré-preenche o destinatário sugerido pelo agente", () => {
    mockFetch();
    render(<SendSummaryEmailCard {...props({ args: { botId: "bot-1", to: "boss@x.com" } })} />);
    expect(screen.getByDisplayValue("boss@x.com")).toBeInTheDocument();
  });

  it("email inválido bloqueia o envio (sem fetch)", async () => {
    const spy = mockFetch();
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props()} />);
    await user.type(screen.getByPlaceholderText(/name@company/i), "invalido");
    await user.click(screen.getByRole("button", { name: /send/i }));
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SendSummaryEmailCard — envio", () => {
  it("clicar Send com email válido faz POST e mostra 'summary sent'", async () => {
    const spy = mockFetch(200, { ok: true });
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props()} />);

    await user.type(screen.getByPlaceholderText(/name@company/i), "boss@x.com");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/summary sent/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("boss@x.com")).toBeInTheDocument();
    // POST na rota certa com o botId da tool.
    expect(spy).toHaveBeenCalledWith(
      "/api/meetings/bot-1/email-summary",
      expect.objectContaining({ method: "POST" }),
    );
    const bodySent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(bodySent.to).toBe("boss@x.com");
  });

  it("inclui a nota no corpo quando preenchida", async () => {
    const spy = mockFetch(200, { ok: true });
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props()} />);
    await user.type(screen.getByPlaceholderText(/name@company/i), "boss@x.com");
    await user.type(screen.getByPlaceholderText(/short message/i), "para o chefe");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const bodySent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(bodySent.note).toBe("para o chefe");
  });

  it("429 mostra aviso de limite e NÃO marca como enviado", async () => {
    mockFetch(429, { error: "rate_limited" });
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props()} />);
    await user.type(screen.getByPlaceholderText(/name@company/i), "boss@x.com");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(screen.getByText(/too many emails/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/summary sent/i)).not.toBeInTheDocument();
  });

  it("not_ready mostra aviso de ata não pronta", async () => {
    mockFetch(400, { error: "not_ready" });
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props()} />);
    await user.type(screen.getByPlaceholderText(/name@company/i), "boss@x.com");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(screen.getByText(/aren't ready/i)).toBeInTheDocument(),
    );
  });
});

describe("SendSummaryEmailCard — cancelar / já resolvido", () => {
  it("clicar Cancel não faz fetch", async () => {
    const spy = mockFetch();
    const user = userEvent.setup();
    render(<SendSummaryEmailCard {...props({ args: { botId: "bot-1", to: "boss@x.com" } })} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("com result.sent, mostra o resumo e não renderiza o formulário", () => {
    render(
      <SendSummaryEmailCard
        {...props({ result: { sent: true, to: "boss@x.com" } })}
      />,
    );
    expect(screen.getByText(/summary sent/i)).toBeInTheDocument();
    expect(screen.getByText("boss@x.com")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/name@company/i)).not.toBeInTheDocument();
  });
});
