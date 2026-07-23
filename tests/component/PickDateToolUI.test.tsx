import type React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * PickDateToolUI — calendário + seletor de horário com DISPONIBILIDADE REAL.
 * O contrato que garantimos:
 *  - horários OCUPADOS na agenda aparecem desabilitados (não confirmam);
 *  - só clicar num horário LIVRE resolve a escolha (dispara addToolResult);
 *  - trocar de dia refaz o fetch de disponibilidade;
 *  - já respondido (result.picked) mostra o resumo, some o seletor.
 *
 * makeAssistantTool roda no top-level do módulo — mockamos @assistant-ui/react
 * para o import não exigir o runtime do assistant-ui em jsdom.
 */

vi.mock("@assistant-ui/react", () => ({
  // Registrar a tool é irrelevante no teste de componente; devolvemos um marcador.
  makeAssistantTool: () => ({ __tool: true }),
}));

import { PickDateCard } from "@/features/meetings/ui/PickDateToolUI";

type Slot = { timeHm: string; datetimeIso: string; busy: boolean; reason?: string };

function availability(slots: Slot[], noCalendar = false) {
  return {
    dateIso: "2026-08-10",
    timeZone: "America/Sao_Paulo",
    slots,
    noCalendar,
  };
}

const FREE_AND_BUSY: Slot[] = [
  { timeHm: "09:00", datetimeIso: "2026-08-10T09:00", busy: false },
  { timeHm: "10:00", datetimeIso: "2026-08-10T10:00", busy: true, reason: "Reunião X" },
  { timeHm: "11:00", datetimeIso: "2026-08-10T11:00", busy: false },
];

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    })),
  );
}

/** Props mínimas de ToolCallMessagePartProps que o PickDateCard consome. */
function props(over: Record<string, unknown> = {}): React.ComponentProps<
  typeof PickDateCard
> {
  return {
    args: { prompt: "escolha o horário" },
    result: undefined,
    toolCallId: "call-1",
    // campos restantes do tipo não são lidos pelo componente
    ...over,
  } as unknown as React.ComponentProps<typeof PickDateCard>;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PickDateCard — estado inicial", () => {
  it("sem dia escolhido, pede para escolher um dia e não faz fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<PickDateCard {...props()} />);
    // "choose ... day" shows in the slots column and the footer — just needs to exist.
    expect(screen.getAllByText(/choose (a )?day/i).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("PickDateCard — disponibilidade real", () => {
  it("ao escolher um dia, busca disponibilidade e marca ocupados como desabilitados", async () => {
    mockFetchOnce(availability(FREE_AND_BUSY));
    const user = userEvent.setup();
    render(<PickDateCard {...props()} />);

    // Escolhe um dia futuro qualquer no calendário (botões de dia habilitados).
    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}$/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("disabled"));
    await user.click(dayButtons[dayButtons.length - 1]);

    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());

    const free = screen.getByRole("button", { name: "09:00" });
    const busy = screen.getByRole("button", { name: "10:00" });
    expect(free).toBeEnabled();
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("title", "Reunião X");
    // Contador de livres: 2 (09:00 e 11:00).
    expect(screen.getByText(/2 free/i)).toBeInTheDocument();
  });

  it("clicar num horário LIVRE mostra o resumo do horário escolhido", async () => {
    mockFetchOnce(availability(FREE_AND_BUSY));
    const user = userEvent.setup();
    render(<PickDateCard {...props()} />);

    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}$/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("disabled"));
    await user.click(dayButtons[dayButtons.length - 1]);
    await waitFor(() => expect(screen.getByText("09:00")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "09:00" }));
    // done state → card de resumo ("horário escolhido").
    await waitFor(() =>
      expect(screen.getByText(/time chosen/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/09:00/)).toBeInTheDocument();
  });

  it("clicar num horário OCUPADO não confirma (segue no seletor)", async () => {
    mockFetchOnce(availability(FREE_AND_BUSY));
    const user = userEvent.setup();
    render(<PickDateCard {...props()} />);

    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}$/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("disabled"));
    await user.click(dayButtons[dayButtons.length - 1]);
    await waitFor(() => expect(screen.getByText("10:00")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "10:00" }));
    // Não deve ter virado o card de resumo.
    expect(screen.queryByText(/time chosen/i)).not.toBeInTheDocument();
  });

  it("dia sem horários livres mostra aviso", async () => {
    mockFetchOnce(
      availability([
        { timeHm: "09:00", datetimeIso: "2026-08-10T09:00", busy: true, reason: "cheio" },
      ]),
    );
    const user = userEvent.setup();
    render(<PickDateCard {...props()} />);

    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}$/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("disabled"));
    await user.click(dayButtons[dayButtons.length - 1]);

    await waitFor(() =>
      expect(screen.getByText(/no free time slots/i)).toBeInTheDocument(),
    );
  });

  it("agenda não conectada exibe aviso de horários não checados", async () => {
    mockFetchOnce(availability(FREE_AND_BUSY, true));
    const user = userEvent.setup();
    render(<PickDateCard {...props()} />);

    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}$/.test(b.textContent?.trim() ?? "") && !b.hasAttribute("disabled"));
    await user.click(dayButtons[dayButtons.length - 1]);

    await waitFor(() =>
      expect(screen.getByText(/calendar not connected/i)).toBeInTheDocument(),
    );
  });
});

describe("PickDateCard — já respondido", () => {
  it("com result.picked, mostra o resumo e não renderiza o calendário", () => {
    render(
      <PickDateCard
        {...props({
          result: {
            picked: true,
            dateIso: "2026-08-10",
            timeHm: "14:00",
            datetimeIso: "2026-08-10T14:00",
          },
        })}
      />,
    );
    expect(screen.getByText(/time chosen/i)).toBeInTheDocument();
    expect(screen.getByText(/14:00/)).toBeInTheDocument();
    // Sem coluna "escolha um dia" — o seletor sumiu.
    expect(screen.queryByText(/choose day and time/i)).not.toBeInTheDocument();
  });
});
