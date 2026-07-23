import { afterAll, afterEach, beforeAll } from "vitest"
import { server } from "./msw/server"

// LIVE mode (RUN_LIVE_E2E=1): load env so live tests hit real services
// (Casper Testnet, Bedrock, Recall). Reads .env.local first (Next's convention —
// creds live there) then .env; first writer wins (??=), so .env.local precedes.
if (process.env.RUN_LIVE_E2E === "1") {
  const fs = await import("node:fs")
  const path = await import("node:path")
  for (const file of [".env.local", ".env"]) {
    const envPath = path.resolve(process.cwd(), file)
    if (!fs.existsSync(envPath)) continue
    const rows = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
    for (const row of rows) {
      const match = row.match(/^([A-Z0-9_]+)=(.*)$/)
      if (!match) continue
      const [, key, rawValue] = match
      process.env[key] ??= rawValue.replace(/^["']|["']$/g, "")
    }
  }
}

// Modo hermético: alguns módulos server-only (ex.: shared/db) chamam requireEnv
// no top-level do import, então importar até uma função pura de um desses
// módulos exige a env presente. O Pool do pg é lazy (só conecta na 1ª query) e
// testes unit nunca fazem query — um valor fake basta para o import não lançar.
// Em modo LIVE não sobrescrevemos (o loader acima já pôs os valores reais).
if (process.env.RUN_LIVE_E2E !== "1") {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test"
}

// Hermetic default: block any unhandled request so unit stays offline.
// LIVE mode bypasses so real-service tests can reach the network.
const unhandled = process.env.RUN_LIVE_E2E === "1" ? "bypass" : "error"
beforeAll(() => server.listen({ onUnhandledRequest: unhandled }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
