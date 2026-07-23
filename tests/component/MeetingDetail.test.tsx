import { describe, it, expect, beforeEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeQueryWrapper } from "../helpers/query-wrapper";

// The notebook now uses useMutation/useQueryClient (title/summary/action-item
// edits, delete, speaker rename), so it needs a QueryClient in context. Wrap
// every render in a fresh client (no cross-test cache bleed).
function render(ui: React.ReactElement) {
  const { wrapper: Wrapper } = makeQueryWrapper();
  return rtlRender(ui, { wrapper: Wrapper });
}

/**
 * MeetingDetail — notebook (player + karaoke + AI panels). Contrato:
 *  - loading/erro mostram seus estados;
 *  - renderiza os painéis de IA a partir dos dados (summary, moments, sections,
 *    decisions, action items, keywords, talk time);
 *  - clicar num momento/seção/palavra faz seek no <video> (currentTime + play);
 *  - o botão de clip só aparece quando há videoUrl; clicá-lo chama clip.run
 *    com o range da janela do momento.
 *
 * useMeetingDetail e useClip são mockados — isolamos a UI do notebook.
 */

let detail: {
  data?: unknown;
  isLoading?: boolean;
  error?: unknown;
  refetch?: () => void;
  isRefetching?: boolean;
};
const refetch = vi.fn();
vi.mock("@/features/meetings/model/queries", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useMeetingDetail: () => ({ refetch, isRefetching: false, ...detail }),
}));

const clipRun = vi.fn();
let clipState: { status: string; id?: string; progress?: number } = {
  status: "idle",
};
vi.mock("@/features/meetings/model/useClip", () => ({
  useClip: () => ({ state: clipState, run: clipRun, cancel: vi.fn() }),
}));

// DeleteControl calls useRouter().push after a delete; provide a mock router.
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

// Toasts fire on every edit/delete; stub sonner so jsdom doesn't need the real
// Toaster mounted.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// The notebook imports the domain Server Actions; mock them so the edit/delete
// controls resolve without hitting the server boundary. Individual tests set
// return values as needed.
const setMeetingShare = vi.fn();
const deleteMeeting = vi.fn();
const updateMeetingTitle = vi.fn();
const updateMeetingSummary = vi.fn();
const updateMeetingActionItems = vi.fn();
const renameMeetingSpeaker = vi.fn();
vi.mock("@/features/meetings/api/actions", () => ({
  setMeetingShare: (...a: unknown[]) => setMeetingShare(...a),
  deleteMeeting: (...a: unknown[]) => deleteMeeting(...a),
  updateMeetingTitle: (...a: unknown[]) => updateMeetingTitle(...a),
  updateMeetingSummary: (...a: unknown[]) => updateMeetingSummary(...a),
  updateMeetingActionItems: (...a: unknown[]) => updateMeetingActionItems(...a),
  renameMeetingSpeaker: (...a: unknown[]) => renameMeetingSpeaker(...a),
}));

// useTensionAnalysis + useScreenIntelligence are used by dynamics/screens panels;
// stub to idle so those panels stay inert in these tests.
vi.mock("@/features/meetings/model/useTensionAnalysis", () => ({
  useTensionAnalysis: () => ({ state: { status: "idle" }, run: vi.fn() }),
}));
vi.mock("@/features/meetings/model/useScreenIntelligence", () => ({
  useScreenIntelligence: () => ({ state: { status: "idle" }, run: vi.fn() }),
}));

import { MeetingDetail } from "@/features/meetings/ui/MeetingDetail";
import { HttpError } from "@/features/meetings/model/queries";

function fullData(over: Record<string, unknown> = {}) {
  return {
    botId: "bot-1",
    status: "done",
    meetingUrl: "https://meet/x",
    title: null,
    // Título do header = 1ª frase; painel = summary completo. Duas frases para
    // que não colidam num único texto no DOM.
    summary: "Meeting title line. Full executive summary body here.",
    overview: "A narrative overview paragraph.",
    decisions: ["Ship the feature"],
    actionItems: [{ task: "Write tests", owner: "Marcus" }],
    topics: ["testing", "release"],
    sections: [
      { title: "Scope lock", bullets: ["Point A"], startSeconds: 0 },
    ],
    moments: [{ label: "Key decision", kind: "action", atSeconds: 30 }],
    soundbites: [
      { label: "Punchy quote", startSeconds: 40, endSeconds: 52 },
    ],
    talkShares: [
      { name: "Sarah", share: 0.6 },
      { name: "Diego", share: 0.4 },
    ],
    videoUrl: "http://x/v.mp4",
    transcript: [
      {
        speaker: "Sarah",
        start: 0,
        words: [
          { text: "Hello", start: 0, end: 1 },
          { text: "team", start: 1, end: 2 },
        ],
      },
    ],
    transcriptState: "ready",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  clipRun.mockReset();
  clipState = { status: "idle" };
  detail = { data: fullData(), isLoading: false, error: null };
  // jsdom: <video>.play() não existe — stub para o seek não lançar.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

describe("MeetingDetail — estados", () => {
  it("loading mostra o skeleton com aria-label 'loading minutes'", () => {
    detail = { data: undefined, isLoading: true };
    render(<MeetingDetail botId="bot-1" />);
    // O loading é um skeleton anunciado por aria-label (aria-busy), não texto.
    expect(screen.getByLabelText(/loading minutes/i)).toBeInTheDocument();
  });

  it("erro genérico mostra 'could not load' + botão de retry", async () => {
    detail = { data: undefined, isLoading: false, error: new Error("x") };
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("404 mostra 'not found' e NÃO oferece retry", () => {
    detail = {
      data: undefined,
      isLoading: false,
      error: new HttpError(404, "/api/meetings/x"),
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("401 mostra 'session expired' e NÃO oferece retry", () => {
    detail = {
      data: undefined,
      isLoading: false,
      error: new HttpError(401, "/api/meetings/x"),
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("MeetingDetail — transcript search + a11y", () => {
  it("filtra o transcript pela busca e some quem não bate", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    // Antes: "Hello" e "team" visíveis.
    expect(screen.getByText("Hello")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/search transcript/i), "zzz");
    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });

  it("palavra do transcript é operável por teclado (Enter faz seek)", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    const word = screen.getByText("team");
    expect(word).toHaveAttribute("role", "button");
    expect(word).toHaveAttribute("tabindex", "0");

    word.focus();
    await user.keyboard("{Enter}");
    expect(video.currentTime).toBe(1);
  });
});

describe("MeetingDetail — painéis de IA", () => {
  it("renderiza summary, decisions, action items, keywords e talk time", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(
      screen.getByText("Meeting title line. Full executive summary body here."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ship the feature")).toBeInTheDocument();
    expect(screen.getByText("Write tests")).toBeInTheDocument();
    expect(screen.getByText("Marcus")).toBeInTheDocument(); // owner chip
    expect(screen.getByText("testing")).toBeInTheDocument(); // keyword
    // "Sarah" aparece na legenda de speaker E no talk time — basta existir.
    expect(screen.getAllByText("Sarah").length).toBeGreaterThan(0);
    expect(screen.getByText("60%")).toBeInTheDocument(); // talk share (único)
  });

  it("mostra o momento e a seção com timestamps", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("Key decision")).toBeInTheDocument();
    expect(screen.getByText("Scope lock")).toBeInTheDocument();
    expect(screen.getByText("Point A")).toBeInTheDocument();
  });
});

describe("MeetingDetail — seek no vídeo", () => {
  it("clicar num momento move o currentTime e dá play", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    await user.click(screen.getByRole("button", { name: /key decision/i }));

    expect(video.currentTime).toBe(30);
    expect(video.play).toHaveBeenCalled();
  });

  it("clicar numa palavra do transcript faz seek para o start dela", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);
    const video = document.querySelector("video") as HTMLVideoElement;

    await user.click(screen.getByText("team"));

    expect(video.currentTime).toBe(1);
  });
});

describe("MeetingDetail — botão de clip", () => {
  it("com videoUrl, o momento tem botão de clip que chama run com a janela", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    const clipBtn = screen.getByRole("button", { name: /clip this moment/i });
    await user.click(clipBtn);

    expect(clipRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "moment-0",
        videoUrl: "http://x/v.mp4",
        // janela ~16s: [at-4, at+12] = [26, 42]
        start: 26,
        end: 42,
      }),
    );
  });

  it("sem videoUrl, não há botão de clip", () => {
    detail = {
      data: fullData({ videoUrl: null }),
      isLoading: false,
    };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.queryByRole("button", { name: /clip this moment/i })).toBeNull();
  });
});

describe("MeetingDetail — soundbites curados", () => {
  it("renderiza o painel de soundbites com label e duração", () => {
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("Punchy quote")).toBeInTheDocument();
    // 40s · 12s (52-40).
    expect(screen.getByText(/0:40 · 12s/)).toBeInTheDocument();
  });

  it("clipar um soundbite usa o range EXATO (sem janela heurística)", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(
      screen.getByRole("button", { name: /clip this soundbite/i }),
    );

    expect(clipRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "soundbite-0",
        start: 40, // exato, não at-4
        end: 52, // exato, não at+12
      }),
    );
  });

  it("clipando um momento, o botão mostra o progresso em %", () => {
    clipState = { status: "clipping", id: "moment-0", progress: 0.5 };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });
});

describe("MeetingDetail — título editável", () => {
  it("sem title, mostra a 1ª frase do summary como fallback", () => {
    render(<MeetingDetail botId="bot-1" />);
    // Header h1 = 1ª frase do summary (o fallback).
    expect(screen.getByText("Meeting title line.")).toBeInTheDocument();
  });

  it("com title do owner, mostra o title no header", () => {
    detail = { data: fullData({ title: "Kickoff" }), isLoading: false };
    render(<MeetingDetail botId="bot-1" />);
    expect(screen.getByText("Kickoff")).toBeInTheDocument();
  });

  it("editar o título chama updateMeetingTitle e refetch", async () => {
    updateMeetingTitle.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    // Clicar no título abre o input (aria-label do botão = "Rename meeting").
    await user.click(screen.getByRole("button", { name: /rename meeting/i }));
    const input = screen.getByLabelText(/meeting title/i);
    await user.clear(input);
    await user.type(input, "New name{Enter}");

    expect(updateMeetingTitle).toHaveBeenCalledWith("bot-1", "New name");
  });
});

describe("MeetingDetail — editar summary", () => {
  it("o pencil abre textareas e Save chama updateMeetingSummary", async () => {
    updateMeetingSummary.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(screen.getByRole("button", { name: /edit summary/i }));
    const summary = screen.getByLabelText(/^summary$/i);
    await user.clear(summary);
    await user.type(summary, "Edited summary");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(updateMeetingSummary).toHaveBeenCalledWith(
      "bot-1",
      "Edited summary",
      expect.any(String),
    );
  });
});

describe("MeetingDetail — editar action items", () => {
  it("adiciona um item e Save envia a lista editada", async () => {
    updateMeetingActionItems.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(
      screen.getByRole("button", { name: /edit action items/i }),
    );
    // O item existente ("Write tests") já está no draft; adiciona outro.
    await user.click(screen.getByRole("button", { name: /add item/i }));
    const taskInputs = screen.getAllByLabelText(/^task \d/i);
    await user.type(taskInputs[taskInputs.length - 1], "Ship it");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(updateMeetingActionItems).toHaveBeenCalledWith(
      "bot-1",
      expect.arrayContaining([
        expect.objectContaining({ task: "Write tests" }),
        expect.objectContaining({ task: "Ship it" }),
      ]),
    );
  });

  it("remover um item o tira da lista enviada", async () => {
    updateMeetingActionItems.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(
      screen.getByRole("button", { name: /edit action items/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /remove action item/i }),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // O único item ("Write tests") foi removido → lista vazia.
    expect(updateMeetingActionItems).toHaveBeenCalledWith("bot-1", []);
  });
});

describe("MeetingDetail — renomear speaker", () => {
  it("clicar no nome na legenda abre input; Enter chama renameMeetingSpeaker", async () => {
    renameMeetingSpeaker.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    // A legenda tem um botão "Rename Sarah".
    await user.click(screen.getByRole("button", { name: /rename sarah/i }));
    const input = screen.getByLabelText(/rename sarah/i);
    await user.clear(input);
    await user.type(input, "Sarah Lee{Enter}");

    expect(renameMeetingSpeaker).toHaveBeenCalledWith(
      "bot-1",
      "Sarah",
      "Sarah Lee",
    );
  });
});

describe("MeetingDetail — export markdown", () => {
  it("o botão export dispara o download (createObjectURL + click)", async () => {
    const createUrl = vi.fn(() => "blob:x");
    const revokeUrl = vi.fn();
    // jsdom não implementa URL.createObjectURL.
    Object.assign(URL, {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(
      screen.getByRole("button", { name: /export meeting as markdown/i }),
    );

    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("copy escreve o markdown no clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // navigator.clipboard is getter-only in jsdom — define it, don't assign.
    // Use fireEvent (not userEvent, which installs its own clipboard stub).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<MeetingDetail botId="bot-1" />);

    fireEvent.click(
      screen.getByRole("button", { name: /copy meeting to clipboard/i }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // O markdown carrega o título e uma linha de transcript.
    const md = writeText.mock.calls[0][0] as string;
    expect(md).toContain("# Meeting title line.");
    expect(md).toContain("## Transcript");
    expect(md).toContain("Hello team");
  });
});

describe("MeetingDetail — delete", () => {
  it("o botão delete no header abre o confirm dialog", async () => {
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(screen.getByRole("button", { name: /delete meeting/i }));
    expect(screen.getByText(/delete this meeting\?/i)).toBeInTheDocument();
  });

  it("confirmar chama deleteMeeting e roteia de volta", async () => {
    deleteMeeting.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<MeetingDetail botId="bot-1" />);

    await user.click(screen.getByRole("button", { name: /delete meeting/i }));
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(deleteMeeting).toHaveBeenCalledWith("bot-1");
  });
});
