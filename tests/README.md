# Tests

Hermetic by default — unit/component run offline (MSW blocks the network).
Integration and e2e are **opt-in** behind env flags; some hit real services
(Casper Testnet node, AWS Bedrock, Recall.ai).

## Layers

| Layer | Runner | Where | Env |
|-------|--------|-------|-----|
| unit | Vitest (node) | `tests/unit/**/*.test.ts(x)` | hermetic |
| component | Vitest (jsdom) | `tests/component/**/*.test.tsx` | hermetic |
| integration | Vitest (node, serial) | `tests/integration/**/*.integration.test.ts` | opt-in `RUN_LIVE_E2E=1` |
| e2e | Playwright | `tests/e2e/*.spec.ts` | opt-in `RUN_LIVE_E2E=1` |

Layout mirrors the feature-based `src/` architecture — group specs by slice
(`tests/unit/wallet`, `tests/component/multisig`, …) so a test lives next to the
domain it exercises.

## Unit + component (hermetic, run anytime)

```bash
pnpm test              # all hermetic vitest projects
pnpm test:unit         # pure logic, no network
pnpm test:component    # React render in jsdom (Testing Library)
```

- **unit** — server/domain logic: Casper codecs, transfer-policy, multisig math,
  key handling, schemas. Node env, `server-only` stubbed so `server/*` imports.
- **component** — renders Client + synchronous Server Components. Async Server
  Components stay in the Playwright e2e suite. Use `makeQueryWrapper()` from
  `tests/helpers/query-wrapper.tsx` for hooks that read through TanStack Query.

## Integration (opt-in)

Serial (`fileParallelism: false`) — suites share the Casper Testnet node, the
store, and an Inngest dev server. Self-skip without `RUN_LIVE_E2E=1`.

```bash
pnpm test:integration          # hermetic-shaped, self-skips live suites
RUN_LIVE_E2E=1 pnpm test:integration   # real Testnet / Bedrock round-trip
```

Covers the on-chain path (transfer → `putTransaction` → confirm) and the
autonomous workflow round-trip.

## E2E — Playwright

Each spec self-skips unless `RUN_LIVE_E2E=1`; the flag also boots `next dev`
(port 3000, `E2E_PORT` to override; reuses an already-running server).

```bash
pnpm exec playwright install chromium     # once
pnpm test:e2e                              # hermetic UI specs
pnpm test:e2e:live                         # RUN_LIVE_E2E=1 — real agent + real tx
```

> LIVE e2e submits a real Native Transfer to Casper Testnet and spends CSPR gas.
> The agent key must be funded (see the root README faucet step).

## Setup files

- `setup.ts` — MSW hermetic guard; loads `.env.local`/`.env` in LIVE mode.
- `setup.component.ts` — jest-dom matchers + Testing Library cleanup + jsdom
  observer/animation stubs.
- `msw/server.ts` — empty MSW server; tests add handlers ad-hoc.
- `stubs/server-only.ts` — stubs `server-only` for the node test env so
  `src/server/*` modules import under vitest.
- `helpers/query-wrapper.tsx` — fresh `QueryClient` per test for hook specs.
