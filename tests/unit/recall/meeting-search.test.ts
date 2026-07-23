import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * searchMeetingRecords — busca cross-meeting nas atas persistidas (meeting_records).
 * Alimenta o Q&A do agente ("o que decidimos sobre pricing?"). Cobrimos:
 *  - o filtro SQL montado (status=done + ILIKE em summary/overview/transcript);
 *  - o escape de wildcards ILIKE (% e _ do usuário não viram curinga);
 *  - a extração do snippet (janela ao redor do primeiro match, com reticências);
 *  - short-circuit de query vazia (sem hit no banco).
 *
 * scopedDb() é mockado: retornamos um query-builder encadeável falso e
 * inspecionamos o que foi passado. A borda RLS (withUserScope) é testada nas tools.
 */

const capture: { where: unknown; limit: number | null } = {
  where: null,
  limit: null,
};
let rows: Array<Record<string, unknown>> = [];

// Query-builder falso: cada passo retorna `this`; where/limit capturam args.
const qb = {
  select: () => qb,
  from: () => qb,
  where: (w: unknown) => {
    capture.where = w;
    return qb;
  },
  orderBy: () => qb,
  limit: (n: number) => {
    capture.limit = n;
    return Promise.resolve(rows);
  },
};

vi.mock("@/shared/db/rls", () => ({
  scopedDb: () => qb,
}));

// drizzle helpers: registram a forma da árvore de condições para asserção.
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ op: "and", args: a }),
  or: (...a: unknown[]) => ({ op: "or", args: a }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  ilike: (col: unknown, pattern: unknown) => ({ op: "ilike", col, pattern }),
  desc: (col: unknown) => ({ op: "desc", col }),
  // usados por outras fns do módulo; presença basta para o import não quebrar.
  inArray: (...a: unknown[]) => ({ op: "inArray", args: a }),
  lt: (...a: unknown[]) => ({ op: "lt", args: a }),
  sql: (...a: unknown[]) => ({ op: "sql", args: a }),
}));

vi.mock("@/shared/db/schema", () => ({
  meetingRecords: {
    botId: { name: "bot_id" },
    summary: { name: "summary" },
    overview: { name: "overview" },
    transcript: { name: "transcript" },
    topics: { name: "topics" },
    status: { name: "status" },
    createdAt: { name: "created_at" },
  },
  // The repository now imports the status enum (for isMeetingStatus).
  meetingRecordStatusEnum: {
    enumValues: ["pending", "processing", "done", "failed"],
  },
}));

beforeEach(() => {
  capture.where = null;
  capture.limit = null;
  rows = [];
});

/** Coleta todos os nós `ilike` da árvore de condições capturada. */
function ilikePatterns(): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.op === "ilike") found.push(String(n.pattern));
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(capture.where);
  return found;
}

describe("searchMeetingRecords — filtro e limite", () => {
  it("query vazia retorna [] sem tocar o banco", async () => {
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    const out = await searchMeetingRecords("   ", 5);
    expect(out).toEqual([]);
    expect(capture.limit).toBeNull(); // nunca chegou ao .limit()
  });

  it("aplica ILIKE em summary/overview/transcript e respeita o limit", async () => {
    rows = [
      {
        botId: "bot-1",
        summary: "Pricing decided",
        overview: null,
        topics: ["pricing"],
        transcript: null,
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
    ];
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    const out = await searchMeetingRecords("pricing", 3);

    expect(capture.limit).toBe(3);
    const patterns = ilikePatterns();
    expect(patterns).toHaveLength(3); // summary, overview, transcript
    expect(patterns.every((p) => p === "%pricing%")).toBe(true);
    expect(out[0].botId).toBe("bot-1");
  });

  it("escapa % e _ do usuário para não virarem curinga", async () => {
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    await searchMeetingRecords("50%_off", 5);
    const patterns = ilikePatterns();
    // % → \% e _ → \_ dentro do padrão, cercado por % de contains.
    expect(patterns[0]).toBe("%50\\%\\_off%");
  });
});

describe("searchMeetingRecords — snippet do transcript", () => {
  it("extrai janela ao redor do match com reticências dos dois lados", async () => {
    const long =
      "A".repeat(200) + " pricing was the key topic " + "B".repeat(200);
    rows = [
      {
        botId: "bot-2",
        summary: null,
        overview: null,
        topics: null,
        transcript: long,
        createdAt: new Date("2026-07-02T00:00:00Z"),
      },
    ];
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    const [hit] = await searchMeetingRecords("pricing", 5);

    expect(hit.snippet).toContain("pricing");
    expect(hit.snippet?.startsWith("…")).toBe(true);
    expect(hit.snippet?.endsWith("…")).toBe(true);
    // janela limitada (não devolve o transcript inteiro).
    expect((hit.snippet ?? "").length).toBeLessThan(300);
  });

  it("snippet é null quando o match está só no summary (não no transcript)", async () => {
    rows = [
      {
        botId: "bot-3",
        summary: "pricing decided",
        overview: null,
        topics: null,
        transcript: "unrelated transcript body",
        createdAt: new Date("2026-07-03T00:00:00Z"),
      },
    ];
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    const [hit] = await searchMeetingRecords("pricing", 5);
    expect(hit.snippet).toBeNull();
  });

  it("match no início do transcript não prefixa reticências", async () => {
    rows = [
      {
        botId: "bot-4",
        summary: null,
        overview: null,
        topics: null,
        transcript: "pricing " + "C".repeat(300),
        createdAt: new Date("2026-07-04T00:00:00Z"),
      },
    ];
    const { searchMeetingRecords } = await import(
      "@/server/recall/meeting-repository"
    );
    const [hit] = await searchMeetingRecords("pricing", 5);
    expect(hit.snippet?.startsWith("…")).toBe(false);
    expect(hit.snippet?.endsWith("…")).toBe(true);
  });
});
