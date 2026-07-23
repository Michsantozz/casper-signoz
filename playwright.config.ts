import { defineConfig, devices } from "@playwright/test"

// Playwright drives the chat + signing surfaces in a real browser. The LIVE
// specs are NOT hermetic — a send hits the Bedrock agent (costs tokens, needs
// creds) and a transfer submits a real tx to Casper Testnet — so they are
// OPT-IN: nothing runs unless RUN_LIVE_E2E=1 (each spec test.skip()s without it,
// mirroring the vitest LIVE convention in tests/setup.ts).
//
// Boot:  RUN_LIVE_E2E=1 pnpm exec playwright test
// The webServer block starts `next dev` and waits for it; reuse an
// already-running dev server when present so you can iterate fast.
const LIVE = process.env.RUN_LIVE_E2E === "1"
const PORT = Number(process.env.E2E_PORT ?? 3000)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: true,
    // LIVE tests need the real env (Bedrock creds, agent key). Non-LIVE runs
    // still boot the server for hermetic UI specs.
    env: LIVE ? { RUN_LIVE_E2E: "1" } : {},
  },
})
