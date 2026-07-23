# syntax=docker/dockerfile:1

# CasperAgent — imagem de produção multi-stage.
# Baseado no exemplo oficial vercel/next.js `with-docker` + output: "standalone".
# node:24 (engines.node >=24), pnpm via corepack (packageManager pin), non-root.

# ---- base ----------------------------------------------------------------
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# corepack respeita packageManager: "pnpm@11.11.0" do package.json (versão exata).
RUN corepack enable

# ---- deps ----------------------------------------------------------------
# Instala deps num layer isolado; só invalida quando lockfile/manifest mudam.
FROM base AS deps
WORKDIR /app
# pnpm-workspace.yaml carrega allowBuilds — sem ele o install ignora build
# scripts nativos (sharp/esbuild) e falha com ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Cache do store do pnpm entre builds (BuildKit). --frozen-lockfile = reprodutível.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=300000 \
      --network-concurrency=8

# ---- builder -------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time: telemetria off + chave de criptografia das Server Actions estável
# entre imagens (senão multi-instância dá "Failed to find Server Action").
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ARG GIT_HASH
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV GIT_HASH=$GIT_HASH

RUN pnpm build

# ---- runner --------------------------------------------------------------
FROM base AS runner
WORKDIR /app

# tini como PID 1: reaper de processos zumbi + repassa SIGTERM ao node
# (sem init, o shell/node como PID 1 ignora sinais → shutdown não gracioso).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Remove o npm/corepack bundlado na imagem base do Node. O runtime roda só
# `node server.js` (Next standalone) — npm nunca é usado em produção. O npm que
# vem com node:24-slim traz um undici@6.26.0 vulnerável (CVE-2026-12151, DoS)
# em node_modules/npm/node_modules/undici, que o scan de imagem (Trivy) flagra
# como HIGH fixável. Deletar o npm elimina a vuln do artefato final sem afetar
# o runtime. (O app usa pnpm; deps já vêm do standalone.)
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/corepack

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Usuário non-root (node:24-slim já traz uid/gid 1000 "node").
USER node

# Standalone traça só o server + deps necessárias. `public/` e `.next/static`
# NÃO são copiados pelo build → precisam vir explícitos. (public/ não existe
# neste projeto; se criar, adicione a linha COPY correspondente.)
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

EXPOSE 3000
# SIGTERM p/ shutdown gracioso: Next drena requests in-flight + callbacks after().
STOPSIGNAL SIGTERM

# Readiness na própria imagem (não só no compose): orquestradores que leem a
# image direto — K8s liveness/readiness, Coolify, Swarm — enxergam este probe.
# `?ready=1` pinga Postgres (SELECT 1) → 503 se DB down. node -e/fetch porque
# slim não garante curl/wget. start-period cobre o boot + primeira migration.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health?ready=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# tini → node server.js (gerado pelo standalone). Sem `next start`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
