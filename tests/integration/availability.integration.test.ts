import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Integração da DISPONIBILIDADE (server/recall/availability.ts) — o cérebro do
 * PickDate. Exercita getDayAvailability DE VERDADE (grade comercial 09:00–18:00,
 * passo 60min, conversão de fuso, classificação livre/ocupado, descarte de
 * passado, merge de eventos sobrepostos). Só as BORDAS de I/O (Recall + repo de
 * calendário + scope RLS) são mockadas — toda a lógica de slot roda real.
 *
 * É o par server do componente PickDateToolUI: o teste de componente confia que
 * a API devolve slots; aqui garantimos que a API os CALCULA certo.
 */

const listCalendarsByUser = vi.fn();
const listCalendarEvents = vi.fn();

vi.mock("@/server/recall/calendar-repository", () => ({
  listCalendarsByUser: (...a: unknown[]) => listCalendarsByUser(...a),
}));
vi.mock("@/server/recall/calendars", () => ({
  listCalendarEvents: (...a: unknown[]) => listCalendarEvents(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (_u: string, fn: () => unknown) => fn(),
}));

import { getDayAvailability, mergeRanges, overlaps } from "@/server/recall/availability";

const TZ = "America/Sao_Paulo"; // UTC-3, sem DST hoje
const DATE = "2026-08-10"; // segunda-feira
// "agora" fixo BEM antes do dia testado → nenhum slot cai no passado.
const NOW = Date.parse("2026-08-01T00:00:00-03:00");

/** Monta um evento no formato que listCalendarEvents devolve (results[]). */
function event(startIso: string, endIso: string, summary?: string) {
  return {
    start_time: startIso,
    end_time: endIso,
    raw: summary ? { summary } : {},
    meeting_platform: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCalendarsByUser.mockResolvedValue([{ recallCalendarId: "cal-1" }]);
  listCalendarEvents.mockResolvedValue({ results: [] });
});

describe("getDayAvailability — grade comercial", () => {
  it("gera 9 slots de hora em hora, 09:00–17:00, todos livres num dia limpo", async () => {
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: NOW });
    expect(day.slots.map((s) => s.timeHm)).toEqual([
      "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
    ]);
    expect(day.slots.every((s) => !s.busy)).toBe(true);
    expect(day.noCalendar).toBe(false);
    expect(day.timeZone).toBe(TZ);
  });
});

describe("getDayAvailability — classificação contra a agenda", () => {
  it("marca como ocupado o slot que colide com um evento, com o título do evento", async () => {
    // Evento 10:00–11:00 local (UTC-3 → 13:00–14:00Z).
    listCalendarEvents.mockResolvedValue({
      results: [event(`${DATE}T13:00:00Z`, `${DATE}T14:00:00Z`, "Daily standup")],
    });
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: NOW });

    const s10 = day.slots.find((s) => s.timeHm === "10:00")!;
    const s09 = day.slots.find((s) => s.timeHm === "09:00")!;
    expect(s10.busy).toBe(true);
    expect(s10.reason).toBe("Daily standup");
    expect(s09.busy).toBe(false); // vizinho intacto
  });

  it("um evento que cobre várias horas ocupa todos os slots afetados", async () => {
    // 09:00–12:00 local → 12:00–15:00Z. Deve ocupar 09,10,11 (12:00 já livre).
    listCalendarEvents.mockResolvedValue({
      results: [event(`${DATE}T12:00:00Z`, `${DATE}T15:00:00Z`, "Workshop")],
    });
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: NOW });
    const busyHm = day.slots.filter((s) => s.busy).map((s) => s.timeHm);
    expect(busyHm).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("evento fora do horário comercial não afeta nenhum slot", async () => {
    // 20:00–21:00 local → 23:00–00:00Z. Fora de 09–18.
    listCalendarEvents.mockResolvedValue({
      results: [event(`${DATE}T23:00:00Z`, `${DATE}T23:59:00Z`, "Jantar")],
    });
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: NOW });
    expect(day.slots.every((s) => !s.busy)).toBe(true);
  });
});

describe("getDayAvailability — descarte de passado", () => {
  it("slots antes de 'agora' viram ocupados com motivo 'já passou'", async () => {
    // "agora" = 13:30 local do próprio dia → 09,10,11,12,13 já passaram.
    const nowMidday = Date.parse(`${DATE}T13:30:00-03:00`);
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: nowMidday });
    const past = day.slots.filter((s) => s.reason === "already past").map((s) => s.timeHm);
    expect(past).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00"]);
    // 14:00 em diante seguem livres.
    expect(day.slots.find((s) => s.timeHm === "14:00")!.busy).toBe(false);
  });
});

describe("getDayAvailability — sem agenda conectada", () => {
  it("noCalendar=true e slots todos livres (não checa conflito)", async () => {
    listCalendarsByUser.mockResolvedValue([]); // nenhuma agenda mapeada
    const day = await getDayAvailability({ userId: "u1", dateIso: DATE, timeZone: TZ, now: NOW });
    expect(day.noCalendar).toBe(true);
    expect(day.slots).toHaveLength(9);
    expect(day.slots.every((s) => !s.busy)).toBe(true);
    expect(listCalendarEvents).not.toHaveBeenCalled();
  });
});

describe("primitivos puros: mergeRanges / overlaps", () => {
  it("mergeRanges funde intervalos sobrepostos e adjacentes", () => {
    expect(mergeRanges([{ start: 0, end: 10 }, { start: 5, end: 15 }])).toEqual([
      { start: 0, end: 15 },
    ]);
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 5, end: 10 }])).toEqual([
      { start: 0, end: 10 },
    ]);
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 10, end: 15 }])).toHaveLength(2);
  });

  it("overlaps detecta interseção e ignora ranges disjuntos", () => {
    const busy = [{ start: 100, end: 200 }];
    expect(overlaps(150, 250, busy)).toBe(true);
    expect(overlaps(50, 100, busy)).toBe(false); // encosta no início, não cruza
    expect(overlaps(200, 300, busy)).toBe(false); // encosta no fim, não cruza
  });
});
