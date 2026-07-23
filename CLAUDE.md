# CasperAgent

AI meeting assistant. Next.js (App Router + RSC) + Mastra (agents/tools/workflows) + Recall.ai (meetings/calendar) + Inngest (scheduled workflows).

Package manager: **pnpm** (enforced — `only-allow pnpm` in preinstall).

## Commands

```bash
pnpm dev            # dev server
pnpm build          # production build (validates RSC/bundler)
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint (includes architecture boundary rules)
pnpm test           # vitest
pnpm db:migrate     # drizzle migrations
```

Before completing any code change: run `pnpm typecheck` **and** `pnpm lint`. Both must pass.

---

# ARCHITECTURE — MANDATORY DIRECTIVE

This project uses a **feature-based architecture (FSD-flavored) colocated with the App Router** — the Next.js strategy where `app/` owns routing only and everything else lives outside it. Next's `app/` files are **thin shells** that re-export the real logic from two `_`-prefixed FSD layers: page logic lives in `_pages/`, route-handler logic in `_app/api-routes/` (the `_` prefix avoids colliding with Next's reserved `app`/`pages` names). The boundary rule is **enforced by ESLint** (`eslint-plugin-boundaries` in `eslint.config.mjs`): violating it breaks `pnpm lint`.

**You MUST respect this architecture for EVERYTHING you add or change.** Do not reorganize back to flat `components/` + `lib/`. Do not "simplify" across layers. Do not add deep imports that bypass the boundaries. This applies to every new file, feature, component, hook, action, route, tool, or dependency — no exceptions.

## Layers (`src/`)

| Layer | Responsibility | May import from |
|-------|----------------|-----------------|
| `app/` | Next routing only. Thin shells that re-export from `_pages/` and `_app/api-routes/`. | `_pages`, `_app` (`next-api`), `features`, `mastra`, `server`, `shared` |
| `_pages/<slice>/` | Page logic (the RSC/page composition behind each `app/**/page.tsx`). | `features`, `shared`, its own page slice |
| `_app/api-routes/` | Route-handler logic (the HTTP bridge behind each `app/api/**/route.ts`). | `features`, `mastra`, `server`, `shared`, `inngest` |
| `features/<domain>/` | Business logic per domain. Each slice: `ui/` `model/` `api/` + `index.ts` (public API). | `shared`, `auth` (cross-cutting), its own slice |
| `mastra/` | The agent: `agents/` `tools/` `workflows/`. Runs server-side. | `mastra`, `server`, `shared`, `auth`, `inngest` |
| `server/` | **server-only** (Recall.ai, calendar, storage): `recall/` `storage/`. Hard boundary — never imported by client UI. | `server`, `shared` |
| `shared/` | Generic, no business logic: `ui/` (shadcn + assistant-ui), `lib/` (http, utils), `db/`. Leaf layer. | `shared` only |
| `inngest/` | Infra: the Inngest client + cron-aware workflow builders. | `inngest` only |

## Current feature slices

`meetings` · `notifications` · `auth` · `assistant`

## Import rules (the core — enforced by lint)

1. **Unidirectional flow**: `app` → `features`/`mastra` → `server`/`shared`. Never the reverse.
2. **Slices don't cross each other** by default. Exceptions already configured in `eslint.config.mjs`:
   - `assistant` (chat orchestrator) may import any slice.
   - `auth` is cross-cutting (session) — any feature may import it.
3. **`shared/` is a leaf**: depends only on `shared/`. Never imports `features` or `server`.
4. **`server/` is server-only**: files carry `import "server-only"`. Feature UI **never** imports `server/`. Only `_app/api-routes/*`, Server Actions, and `mastra/` touch `server/`.
5. **Alias imports `@/`** (mapped to `src/`). No `../../..`. Relative `./` imports are fine only within the same module/slice.
6. **Barrels (`index.ts`) are the slice public API.** Prefer importing through the barrel; avoid deep-importing into another slice's internals.

## RSC / client-server model (Next 2026 idioms)

- **Server by default.** Components are React Server Components unless they need interactivity. Add `"use client"` only at the leaf that actually needs state/effects/handlers — keep the boundary as low as possible.
- **Data reads**:
  - Server (RSC, route handlers, Server Actions) read data directly from `server/*` and `shared/db`.
  - Client components read via `features/<domain>/model` hooks (TanStack Query). Client UI must NOT import `server/` — it calls a route handler or a Server Action.
- **Data writes / mutations**: prefer **Server Actions** (`"use server"`) over ad-hoc fetch when the mutation belongs to a domain. Place them in `features/<domain>/api/` (e.g. `features/meetings/api/actions.ts`). An action may import `server/*` and `shared/*`; it is the bridge, so client UI imports the action, not `server/`.
- **`"use client"` files** live inside the owning slice's `ui/` (or `shared/ui/` if generic). The `"use server"` boundary lives in that slice's `api/`.
- **Shared types** used by both server and client go in the slice's `model/` (types only, no server-only runtime) or `shared/` if truly generic. Never pull a type across the boundary from a `server-only` module into client code — extract the type to `model/`.

## Where new code goes

- **New chat tool-UI** → `features/<owning-domain>/ui/`. Generic/cross-domain? → `features/assistant/ui/`.
- **New server-side integration logic** → `server/recall/` (Recall.ai/calendar) or `server/storage/` (durable media).
- **New scheduled workflow** → `mastra/workflows/` using the cron-aware `createWorkflow`/`createStep` from `@/inngest/client`.
- **New data hook (TanStack Query, client)** → `features/<domain>/model/`.
- **New mutation** → Server Action in `features/<domain>/api/actions.ts` (preferred), or a route handler in `_app/api-routes/` (with a shell in `app/api/`) for webhooks/external callers.
- **New reusable UI primitive (no business logic)** → `shared/ui/`.
- **New page** → logic in `_pages/<slice>/ui/`, with a thin shell `app/**/page.tsx` re-exporting it.
- **New route/endpoint** → logic in `_app/api-routes/`, with a thin shell `app/api/**/route.ts` re-exporting the handler.
- **New whole domain** → create `features/<new>/` with `{ui,model,api}` + `index.ts`, and add its boundary policy in `eslint.config.mjs` if it must cross slices.

## Crossing a new boundary

Do not bypass the rule with a deep import. Either (a) move the code to the correct layer, or (b) add an explicit `policy` in `eslint.config.mjs` with a comment justifying why. Every exception stays documented in the config and is code-reviewed.

---

## General conventions

- Commits/PRs/branch names: **English** (repo convention).
- Keep `server-only` on every `server/` file that must not reach the client bundle (including barrels that re-export server-only modules).
