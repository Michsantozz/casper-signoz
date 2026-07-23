import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tools de Q&A cross-meeting do agente: list_my_meetings e search_my_meetings.
 * Ambas leem meeting_records (RLS-scoped). A borda de SEGURANÇA é o ponto crítico:
 *  - derivam o userId da SESSÃO (nunca de argumento do chat);
 *  - envolvem a leitura em withUserScope(userId) — scopedDb() é fail-closed fora
 *    de scope, e um withSystemScope aqui vazaria reuniões de todos os usuários;
 *  - sem sessão: retornam vazio, sem consultar o repo.
 *
 * Repo e sessão são mockados; verificamos o userId propagado ao withUserScope
 * e o mapeamento do output (Date → ISO string do outputSchema).
 */

const getSession = vi.fn();
const listMeetingRecordsForUser = vi.fn();
const searchMeetingRecords = vi.fn();
// Registra o userId com que o scope foi aberto — o cerne do isolamento.
const withUserScope = vi.fn((_userId: string, fn: () => unknown) => fn());

vi.mock("@/features/auth/model/session", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  listMeetingRecordsForUser: (...a: unknown[]) =>
    listMeetingRecordsForUser(...a),
  searchMeetingRecords: (...a: unknown[]) => searchMeetingRecords(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (userId: string, fn: () => unknown) =>
    withUserScope(userId, fn),
}));

// A tool importa vários helpers de @/server/recall/client — stub para o import
// do módulo de tools não puxar rede/env. Só as duas tools sob teste importam.
vi.mock("@/server/recall/client", () => ({
  recallFetch: vi.fn(),
  RecallAdhocPoolError: class extends Error {},
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByDedupKey: vi.fn(),
  saveBotMapping: vi.fn(),
  deleteBotMapping: vi.fn(),
  defaultDedupKey: vi.fn(),
}));
vi.mock("@/server/recall/summarize", () => ({
  summarizeMeeting: vi.fn(),
}));

async function run(toolName: "list" | "search", input: unknown) {
  const mod = await import("@/mastra/tools/recall.tool");
  const tool =
    toolName === "list" ? mod.listMyMeetingsTool : mod.searchMyMeetingsTool;
  // Mastra createTool: execute(inputData, context). As tools sob teste leem só
  // o inputData (1º arg posicional); context não é usado por elas.
  return (tool.execute as (input: unknown) => Promise<unknown>)(input);
}

beforeEach(() => {
  getSession.mockReset();
  listMeetingRecordsForUser.mockReset();
  searchMeetingRecords.mockReset();
  withUserScope.mockClear();
});

describe("list_my_meetings — isolamento por usuário", () => {
  it("abre withUserScope com o userId da sessão e mapeia o output", async () => {
    getSession.mockResolvedValue({ user: { id: "user-42" } });
    listMeetingRecordsForUser.mockResolvedValue([
      {
        botId: "bot-1",
        status: "done",
        summary: "Sync",
        participantCount: 3,
        meetingUrl: "https://meet/x",
        createdAt: new Date("2026-07-05T10:00:00Z"),
      },
    ]);

    const out = (await run("list", { limit: 20 })) as {
      count: number;
      meetings: Array<{ botId: string; createdAt: string }>;
    };

    // Scope aberto com o dono da sessão — nunca system, nunca outro id.
    expect(withUserScope).toHaveBeenCalledTimes(1);
    expect(withUserScope.mock.calls[0][0]).toBe("user-42");
    expect(out.count).toBe(1);
    // Date serializada como ISO no output.
    expect(out.meetings[0].createdAt).toBe("2026-07-05T10:00:00.000Z");
  });

  it("sem sessão: retorna vazio SEM consultar o repo nem abrir scope", async () => {
    getSession.mockResolvedValue(null);
    const out = (await run("list", {})) as { count: number };
    expect(out.count).toBe(0);
    expect(withUserScope).not.toHaveBeenCalled();
    expect(listMeetingRecordsForUser).not.toHaveBeenCalled();
  });

  it("default de limit é 20 quando não informado", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1" } });
    listMeetingRecordsForUser.mockResolvedValue([]);
    await run("list", {});
    expect(listMeetingRecordsForUser).toHaveBeenCalledWith(20);
  });
});

describe("search_my_meetings — isolamento por usuário", () => {
  it("busca sob withUserScope do usuário da sessão", async () => {
    getSession.mockResolvedValue({ user: { id: "user-7" } });
    searchMeetingRecords.mockResolvedValue([
      {
        botId: "bot-9",
        summary: "Pricing",
        overview: null,
        topics: ["pricing"],
        snippet: "…pricing…",
        createdAt: new Date("2026-07-06T00:00:00Z"),
      },
    ]);

    const out = (await run("search", { query: "pricing", limit: 5 })) as {
      count: number;
      hits: Array<{ botId: string; createdAt: string }>;
    };

    expect(withUserScope).toHaveBeenCalledTimes(1);
    expect(withUserScope.mock.calls[0][0]).toBe("user-7");
    expect(searchMeetingRecords).toHaveBeenCalledWith("pricing", 5);
    expect(out.count).toBe(1);
    expect(out.hits[0].createdAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("sem sessão: vazio, sem busca nem scope", async () => {
    getSession.mockResolvedValue(undefined);
    const out = (await run("search", { query: "pricing" })) as {
      count: number;
    };
    expect(out.count).toBe(0);
    expect(withUserScope).not.toHaveBeenCalled();
    expect(searchMeetingRecords).not.toHaveBeenCalled();
  });

  it("default de limit é 5", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1" } });
    searchMeetingRecords.mockResolvedValue([]);
    await run("search", { query: "x" });
    expect(searchMeetingRecords).toHaveBeenCalledWith("x", 5);
  });
});
