import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * NotificationBell — sino global. Contrato:
 *  - deslogado (sessão nula): não renderiza nada;
 *  - badge mostra a contagem de não-lidas (9+ acima de 9);
 *  - clicar abre o painel; clicar num item marca como lido e navega para /meetings.
 *
 * Hooks de sessão/dados e o router do Next são mockados — isolamos a UI do sino.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

let sessionUser: { user?: { id: string } } | undefined;
vi.mock("@/features/auth/model/auth-client", () => ({
  useSession: () => ({ data: sessionUser }),
}));

const markMutate = vi.fn();
let notifData:
  | { notifications: unknown[]; unreadCount: number }
  | undefined;
vi.mock("@/features/notifications/model/queries", () => ({
  useNotifications: () => ({ data: notifData }),
  useMarkNotificationRead: () => ({ mutate: markMutate }),
}));

import { NotificationBell } from "@/features/notifications/ui/NotificationBell";

function notif(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    type: "meeting_summary_ready",
    message: "Ata pronta",
    link: "/meetings/bot-1",
    readAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = { user: { id: "u1" } };
  notifData = { notifications: [], unreadCount: 0 };
});
afterEach(() => cleanup());

describe("NotificationBell — visibilidade", () => {
  it("deslogado não renderiza nada", () => {
    sessionUser = undefined;
    const { container } = render(<NotificationBell />);
    expect(container).toBeEmptyDOMElement();
  });

  it("logado renderiza o botão do sino", () => {
    render(<NotificationBell />);
    expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument();
  });
});

describe("NotificationBell — badge de não-lidas", () => {
  it("mostra a contagem exata", () => {
    notifData = { notifications: [notif()], unreadCount: 3 };
    render(<NotificationBell />);
    expect(screen.getByLabelText(/3 unread/i)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("acima de 9 mostra 9+", () => {
    notifData = { notifications: [notif()], unreadCount: 42 };
    render(<NotificationBell />);
    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("zero não-lidas não mostra badge", () => {
    notifData = { notifications: [], unreadCount: 0 };
    render(<NotificationBell />);
    expect(screen.queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
  });
});

describe("NotificationBell — painel e navegação", () => {
  it("abre o painel ao clicar e lista as notificações", async () => {
    notifData = {
      notifications: [notif({ message: "Ata pronta" })],
      unreadCount: 1,
    };
    const user = userEvent.setup();
    render(<NotificationBell />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText("Ata pronta")).toBeInTheDocument();
  });

  it("painel vazio mostra estado 'nada por aqui'", async () => {
    notifData = { notifications: [], unreadCount: 0 };
    const user = userEvent.setup();
    render(<NotificationBell />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    expect(screen.getByText(/nothing here/i)).toBeInTheDocument();
  });

  it("clicar num item marca lido e faz deep-link para o notebook", async () => {
    notifData = {
      notifications: [notif({ id: "nX", link: "/meetings/bot-9" })],
      unreadCount: 1,
    };
    const user = userEvent.setup();
    render(<NotificationBell />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await user.click(screen.getByText("Ata pronta"));

    expect(markMutate).toHaveBeenCalledWith("nX");
    expect(push).toHaveBeenCalledWith("/meetings/bot-9");
  });

  it("sem link, cai no índice /meetings", async () => {
    notifData = {
      notifications: [notif({ id: "nY", link: null })],
      unreadCount: 1,
    };
    const user = userEvent.setup();
    render(<NotificationBell />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await user.click(screen.getByText("Ata pronta"));

    expect(push).toHaveBeenCalledWith("/meetings");
  });

  it("não re-marca lido um item já lido, mas ainda navega", async () => {
    notifData = {
      notifications: [
        notif({ id: "nZ", link: "/meetings/bot-3", readAt: new Date().toISOString() }),
      ],
      unreadCount: 0,
    };
    const user = userEvent.setup();
    render(<NotificationBell />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await user.click(screen.getByText("Ata pronta"));

    expect(markMutate).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/meetings/bot-3");
  });
});
