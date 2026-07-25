import { test, expect } from "@playwright/test";

/**
 * E2E da observability / SRE-copilot. Dois níveis, mesma convenção das outras
 * specs:
 *
 *  HERMÉTICO (roda sempre): as duas superfícies operacionais novas são
 *  auth-gated e fail-closed. Deslogado, POST /api/internal/agent-health-watch
 *  (trigger manual do watch autônomo) e POST /api/chat (por onde o sreAgent é
 *  alcançado) devolvem 401 — sem sessão, o watch não roda e o agente não é
 *  invocado. É o par e2e dos unit de rota (agent-health-watch-route.test.ts),
 *  agora com o Next real em vez de mock de handler.
 *
 *  LIVE (opt-in, RUN_LIVE_E2E=1): exige que o usuário da sessão esteja em
 *  OPERATOR_USER_IDS/OPERATOR_EMAILS. O sreAgent é selecionado diretamente —
 *  ele não faz mais parte do supervisor acessível a usuários comuns.
 */

test.describe("agent-health — hermético (deslogado)", () => {
  test("POST /api/internal/agent-health-watch sem sessão → 401 (watch não roda)", async ({
    page,
  }) => {
    // Endpoint operacional, fail-closed: sem sessão o pass não é executado.
    const res = await page.request.post("/api/internal/agent-health-watch");
    expect(res.status()).toBe(401);
  });

  test("?notify=0 deslogado ainda é 401 (auth antes de qualquer trabalho)", async ({
    page,
  }) => {
    const res = await page.request.post(
      "/api/internal/agent-health-watch?notify=0",
    );
    expect(res.status()).toBe(401);
  });

  test("POST /api/chat sem sessão → 401 (sreAgent inalcançável deslogado)", async ({
    page,
  }) => {
    // O sreAgent só é atingido via chat, que é auth-gated. Sem sessão, 401 —
    // nenhuma telemetria interna é consultada por um anônimo.
    const res = await page.request.post("/api/chat", {
      data: { messages: [] },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("agent-health — LIVE (logado, agente real)", () => {
  test.skip(process.env.RUN_LIVE_E2E !== "1", "opt-in: RUN_LIVE_E2E=1");

  test("trigger manual do watch retorna um summary (notify=0, dry run)", async ({
    page,
  }) => {
    // Pré-requisito: sessão válida e usuário na allowlist de operadores.
    // notify=0 → roda o pass e devolve o summary SEM fanout de notificação.
    const res = await page.request.post(
      "/api/internal/agent-health-watch?notify=0",
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { ran: boolean; summary: string };
    // ran=true e um summary não-vazio; sem SIGNOZ_MCP_URL o agente diz que o
    // backend não está conectado — mas o pass roda e responde algo.
    expect(body.ran).toBe(true);
    expect(body.summary.length).toBeGreaterThan(0);
  });

  test("operador consegue selecionar o sreAgent diretamente", async ({
    page,
  }) => {
    const res = await page.request.post("/api/chat", {
      data: {
        agentId: "sreAgent",
        messages: [
          {
            role: "user",
            parts: [
              {
                type: "text",
                text: "how many tokens did I spend today by model?",
              },
            ],
          },
        ],
      },
    });
    expect(res.status()).toBe(200);
  });
});
