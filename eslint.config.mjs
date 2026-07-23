import next from "eslint-config-next";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = [
  ...next,

  // ---- Arquitetura: fronteiras entre camadas (feature-based, App Router) ----
  // Regra de import unidirecional: app -> features/mastra -> server/shared.
  // Slices de features não cruzam entre si (exceto assistant, orquestrador do chat).
  // server (server-only) nunca é importado pela UI de features.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["src/**/*"],
      "boundaries/elements": [
        { type: "app", pattern: "src/app/**/*" },
        // Camadas FSD-Next: a pasta `app/` do Next é só roteamento (shells finas
        // que re-exportam). A lógica real das páginas mora em `_pages/` e a das
        // route handlers em `_app/api-routes/`. Prefixo `_` evita colisão com as
        // pastas reservadas do Next (app/pages) — convenção oficial do FSD.
        { type: "next-page", pattern: "src/_pages/**/*", capture: ["slice"] },
        { type: "next-api", pattern: "src/_app/**/*" },
        { type: "mastra", pattern: "src/mastra/**/*" },
        { type: "server", pattern: "src/server/**/*" },
        // Infra: cliente Inngest + builders de workflow cron-aware. Camada folha
        // (só depende de libs externas). Consumida por mastra/workflows e pela
        // route handler do inngest (_app/api-routes/inngest).
        { type: "infra", pattern: "src/inngest/**/*" },
        // O `api/` de um slice são as Server Actions ("use server"): a PONTE
        // que a UI cliente chama para mutar. É a única parte do slice que pode
        // tocar server/*. Declarado ANTES de "feature" (first-match ganha) e com
        // partialMatch:false para ancorar o caminho ao root — assim distingue
        // `features/*/api` de `features/*` (que casaria por sufixo). Captura o
        // family p/ escopar a política ao próprio slice.
        {
          type: "feature-api",
          pattern: "src/features/*/api",
          partialMatch: false,
          capture: ["family"],
        },
        // captura o nome do slice (multisig, wallet, ...) em "family"
        { type: "feature", pattern: "src/features/*/**/*", capture: ["family"] },
        { type: "shared", pattern: "src/shared/**/*" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            // app (Next) = só roteamento: re-exporta as camadas FSD e, durante
            // a migração, pode ainda puxar direto de features/mastra/server.
            {
              from: { type: "app" },
              allow: {
                to: {
                  type: [
                    "next-page",
                    "next-api",
                    "feature",
                    "feature-api",
                    "mastra",
                    "server",
                    "shared",
                  ],
                },
              },
            },
            // _pages (lógica das páginas): compõe UI de slices + shared.
            {
              from: { type: "next-page" },
              allow: {
                to: [
                  { type: ["feature", "feature-api", "shared"] },
                  { type: "next-page", captured: { slice: "{{ from.captured.slice }}" } },
                ],
              },
            },
            // _app/api-routes (lógica das route handlers): a ponte HTTP, pode
            // tocar toda a stack server-side + slices, igual a rota antiga fazia.
            {
              from: { type: "next-api" },
              allow: {
                to: {
                  type: [
                    "feature",
                    "feature-api",
                    "mastra",
                    "server",
                    "shared",
                    "infra",
                    "next-api",
                  ],
                },
              },
            },
            // mastra (server-side) pode puxar lógica de negócio server + shared + infra (inngest) + sessão (auth)
            {
              from: { type: "mastra" },
              allow: {
                to: [
                  { type: ["mastra", "server", "shared", "infra"] },
                  { type: "feature", captured: { family: "auth" } },
                ],
              },
            },
            // server-only pode compor com server + shared. Exceção: `mastra` —
            // APENAS pelo model provider (@/mastra/model). O provedor de LLM
            // (Bedrock/Fireworks) e o embedder vivem em mastra/model, e a lógica
            // server-side (summarize, dynamics-insight) precisa gerar texto/
            // embeddings. É a única razão de server→mastra; não use para puxar
            // agents/tools/workflows (esses só rodam via a camada mastra).
            {
              from: { type: "server" },
              allow: { to: { type: ["server", "shared", "mastra"] } },
            },
            // o slice "assistant" orquestra o chat: pode consumir outros slices (tool-UIs)
            {
              from: { type: "feature", captured: { family: "assistant" } },
              allow: { to: { type: ["shared", "feature"] } },
            },
            // auth é cross-cutting e roda server-side (config do better-auth): pode
            // tocar server para enviar e-mail de verificação/reset/magic-link.
            {
              from: { type: "feature", captured: { family: "auth" } },
              allow: { to: { type: ["shared", "server"] } },
            },
            // Server Actions (o `api/` do slice) são a ponte de mutação: podem
            // tocar server + shared + auth (sessão) + o próprio slice. A UI do
            // slice continua SEM acesso a server — só o api/ atravessa.
            {
              from: { type: "feature-api" },
              allow: {
                to: [
                  { type: ["server", "shared"] },
                  { type: "feature", captured: { family: "auth" } },
                  { type: "feature-api", captured: { family: "{{ from.captured.family }}" } },
                  { type: "feature", captured: { family: "{{ from.captured.family }}" } },
                ],
              },
            },
            // demais slices: shared + auth (transversal, sessão) + o próprio slice
            {
              from: { type: "feature" },
              allow: {
                to: [
                  { type: "shared" },
                  { type: "feature", captured: { family: "auth" } },
                  { type: "feature", captured: { family: "{{ from.captured.family }}" } },
                  { type: "feature-api", captured: { family: "{{ from.captured.family }}" } },
                ],
              },
            },
            // shared é folha: só depende de shared
            {
              from: { type: "shared" },
              allow: { to: { type: "shared" } },
            },
            // inngest é folha de infra: só libs externas, nada do próprio src
            // além de si mesmo.
            {
              from: { type: "infra" },
              allow: { to: { type: "infra" } },
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
