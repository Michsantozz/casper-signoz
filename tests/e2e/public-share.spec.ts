import { test, expect } from "@playwright/test";

/**
 * E2E do share público de reunião (/share/[token]). Dois níveis, no mesmo
 * padrão do meetings.spec:
 *
 *  HERMÉTICO (roda sempre): a borda de segurança é o token. Um token
 *  desconhecido/revogado devolve 404 na API pública — SEM vazar se o botId
 *  existe — e a page /share/[token] renderiza uma casca, não dados de ninguém.
 *  É o par e2e (servidor real) do teste de findMeetingByShareToken.
 *
 *  LIVE (opt-in, RUN_LIVE_E2E=1): com um token válido semeado, a view pública
 *  abre e mostra a ata. Precisa de dados reais; fica atrás da flag.
 */

test.describe("public share — hermético", () => {
  test("token desconhecido: a API pública devolve 404 (não vaza existência)", async ({
    page,
  }) => {
    const res = await page.request.get(
      "/api/public/meetings/__nonexistent_token__",
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  test("token vazio/aleatório não é tratado como autorizado", async ({ page }) => {
    // Um token forjado nunca deve devolver uma reunião — só 404.
    const res = await page.request.get(
      "/api/public/meetings/deadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(res.status()).toBe(404);
  });

  test("/share/[token] devolve 404 real para token desconhecido", async ({ page }) => {
    // A autorização é o token e agora a própria página o resolve no RSC, antes
    // de emitir o documento, preservando a semântica HTTP correta.
    const res = await page.goto("/share/__nonexistent_token__", {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  });
});

test.describe("public share — LIVE (token válido semeado)", () => {
  test.skip(process.env.RUN_LIVE_E2E !== "1", "opt-in: RUN_LIVE_E2E=1");

  test("um token válido abre a view pública da ata", async ({ page }) => {
    // Pré-requisito: uma reunião "done" com share habilitado e o token em
    // SHARE_TOKEN (semeadura a cargo do runner LIVE).
    const token = process.env.SHARE_TOKEN;
    test.skip(!token, "defina SHARE_TOKEN para o teste LIVE");

    await page.goto(`/share/${token}`, { waitUntil: "domcontentloaded" });
    // A view pública mostra o player/ata, não um 404.
    await expect(page.getByText(/not_found/i)).toHaveCount(0);
  });
});
