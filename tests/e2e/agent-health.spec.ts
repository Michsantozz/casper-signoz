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
 *  LIVE (opt-in, RUN_LIVE_E2E=1): com sessão real e SIGNOZ_MCP_URL AUSENTE,
 *  perguntar ao chat sobre a própria telemetria exercita o path de degrade
 *  gracioso ponta-a-ponta: o supervisor delega ao sreAgent, que — sem tools de
 *  telemetria — responde que o backend não está conectado, em vez de fabricar
 *  métricas. Precisa de sessão + agente real (custa tokens), por isso fica atrás
 *  da flag, como as outras LIVE.
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
    // Pré-requisito: sessão válida (semeadura/login a cargo do runner LIVE).
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

  test("perguntar sobre a própria telemetria degrada com elegância (sem SigNoz MCP)", async ({
    page,
  }) => {
    // Sem SIGNOZ_MCP_URL, o sreAgent não tem tools: deve dizer que a telemetria
    // não está conectada, nunca inventar números. Dirigimos a UI do chat.
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const composer = page.getByRole("textbox").first();
    await composer.fill("how many tokens did I spend today by model?");

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/chat") && r.request().method() === "POST",
      ),
      composer.press("Enter"),
    ]);

    expect(res.status()).toBe(200);
    // Resposta do supervisor+sreAgent: menciona que o backend de telemetria não
    // está conectado (não fabrica métricas). Aceita variações do fraseado.
    await expect(
      page.getByText(/telemetry|SigNoz|not.*(wired|connected|configured)/i),
    ).toBeVisible({ timeout: 60_000 });
  });
});
