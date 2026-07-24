import { test, expect } from "@playwright/test";

/**
 * E2E do login (Tier 1) na home. Dois níveis:
 *
 *  HERMÉTICO (roda sempre): deslogado, a home mostra a LoginScreen com os três
 *  métodos (Google + magic link + senha). Não precisa de creds nem toca serviço
 *  externo — só verifica que o gate de sessão renderiza a tela certa e que a UI
 *  alterna entre magic link e senha (signup/forgot). É o par e2e dos testes de
 *  componente: aqui é o Next real servindo a página, não jsdom.
 *
 *  Os labels da UI são em INGLÊS (LoginScreen.tsx) — os seletores abaixo casam
 *  com o texto real ("Password", "Sign up", "Forgot password", …).
 *
 *  LIVE (opt-in, RUN_LIVE_E2E=1): dispara o magic link DE VERDADE (better-auth →
 *  Resend). Sem a flag, test.skip() — mesma convenção do vitest LIVE. Precisa do
 *  server com env real (Resend, DB) de pé.
 */

test.describe("login — hermético (deslogado)", () => {
  test("home mostra a LoginScreen com os três métodos", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Casper Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in with google/i })).toBeVisible();
    // Abas de magic link e senha.
    await expect(page.getByRole("button", { name: /magic link/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^password$/i })).toBeVisible();
  });

  test("aba default (magic link) mostra e-mail + botão de enviar link", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("you@email.com")).toBeVisible();
    await expect(page.getByRole("button", { name: /send access link/i })).toBeVisible();
  });

  test("alternar para Senha revela campo de senha, criar-conta e esqueci-senha", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^password$/i }).click();

    await expect(page.getByPlaceholder("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign up$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /forgot password/i })).toBeVisible();
  });

  test("modo signup adiciona campo de nome", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^password$/i }).click();
    await page.getByRole("button", { name: /^sign up$/i }).click();
    await expect(page.getByPlaceholder("Your name")).toBeVisible();
  });
});

test.describe("login — LIVE (magic link real via Resend)", () => {
  test.skip(process.env.RUN_LIVE_E2E !== "1", "opt-in: RUN_LIVE_E2E=1");

  test("enviar magic link retorna sucesso e mostra confirmação", async ({ page }) => {
    await page.goto("/");
    // Aba magic link é a default.
    await page.getByPlaceholder("you@email.com").fill("e2e@ultraself.com.br");

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/sign-in/magic-link") && r.request().method() === "POST",
      ),
      page.getByRole("button", { name: /send access link/i }).click(),
    ]);

    expect(res.status()).toBe(200);
    await expect(page.getByText(/we sent an access link/i)).toBeVisible();
  });
});
