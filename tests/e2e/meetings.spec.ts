import { test, expect } from "@playwright/test";

/**
 * E2E do fluxo de reuniões (lista → notebook). Dois níveis:
 *
 *  HERMÉTICO (roda sempre): a página /meetings é servida pelo Next real e
 *  monta a shell da lista (header "Meetings", busca). Deslogado, a leitura de
 *  dados (/api/meetings) devolve 401 e a UI cai no estado de erro — mas a
 *  ROTA e a casca renderizam. É o par e2e dos testes de componente da lista,
 *  agora com o servidor de verdade em vez de jsdom.
 *
 *  LIVE (opt-in, RUN_LIVE_E2E=1): navega logado, garante que a lista carrega
 *  do DB e que clicar numa reunião "done" abre o notebook (player + Thread).
 *  Precisa de sessão real + dados semeados; por isso fica atrás da flag.
 */

test.describe("meetings — hermético (deslogado)", () => {
  test("/meetings serve a shell da lista (header + busca)", async ({ page }) => {
    await page.goto("/meetings", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Meetings" }),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/search meetings/i)).toBeVisible();
  });

  test("o rail de navegação tem o item Meetings", async ({ page }) => {
    await page.goto("/meetings", { waitUntil: "domcontentloaded" });
    // Rail desktop: link para /meetings (aria-label "Meetings").
    await expect(
      page.locator('a[href="/meetings"]').first(),
    ).toBeVisible();
  });

  test("deslogado, a leitura de /api/meetings é barrada (401)", async ({
    page,
  }) => {
    // A borda de segurança é o endpoint: sem sessão, 401 (RLS fail-closed).
    // Não vaza reunião de ninguém, independente do que a UI faça com o erro.
    const res = await page.request.get("/api/meetings");
    expect(res.status()).toBe(401);
  });
});

test.describe("meetings — LIVE (logado, dados reais)", () => {
  test.skip(process.env.RUN_LIVE_E2E !== "1", "opt-in: RUN_LIVE_E2E=1");

  test("lista carrega e um item transcrito abre o notebook", async ({
    page,
  }) => {
    // Pré-requisito: sessão válida + ao menos uma reunião "done" semeada.
    // (A semeadura/login fica a cargo do runner LIVE — aqui só dirigimos a UI.)
    await page.goto("/meetings", { waitUntil: "domcontentloaded" });

    const firstDone = page
      .getByRole("link", { name: /open notebook/i })
      .first();
    await expect(firstDone).toBeVisible();
    await firstDone.click();

    await expect(page).toHaveURL(/\/meetings\/.+/);
    // Notebook: cabeçalho terminal + Thread do assistant ao lado.
    await expect(page.getByText(/notebook · recall\.ai/i)).toBeVisible();
    await expect(page.getByText(/meeting assistant/i)).toBeVisible();
  });
});
