import type { NextConfig } from "next";
import path from "node:path";

const isProd = process.env.NODE_ENV === "production";

/**
 * Headers de segurança. Twenty (referência que auditamos) NÃO tem nenhum — deixa
 * pra camada de proxy —, o que é frágil pra self-host. Aqui setamos explícito no
 * app, independente da infra à frente.
 *
 * A CSP restritiva só entra em produção: em dev o Next injeta eval/inline p/ HMR
 * e uma CSP dura quebra o WebSocket de recarga. `frame-ancestors 'none'` protege
 * contra clickjacking.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  ...(isProd
    ? [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            // Next injeta scripts inline hidratados; sem nonce global, 'unsafe-inline'
            // é o baseline. Endurecer com nonce é evolução futura.
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            // Vídeo/áudio das atas vêm do object storage (MinIO/S3/R2), que pode
            // estar em outra origem que 'self' — inclui http: pro MinIO local
            // self-host e blob: caso o player use object URLs. Sem media-src o
            // <video> cairia no default-src 'self' e o player não carregaria.
            "media-src 'self' blob: http: https:",
            "font-src 'self' data:",
            // APIs externas que o cliente chama (AWS/Bedrock é server-side).
            // Ajuste conforme os hosts reais em uso.
            "connect-src 'self' https: wss:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join("; "),
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // lucide-react é um barrel com ~1.5k re-exports; sem esta transform o Next
  // carrega o grafo inteiro em cada um dos 24 arquivos que importam ícones
  // (200-800ms de cold start + HMR lento). optimizePackageImports reescreve os
  // named-imports para caminhos diretos por ícone, mantendo tipos/autocomplete.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  // Build standalone: `.next/standalone` traça só o server + node_modules
  // necessários, sem `next start` nem node_modules inteiro na imagem Docker.
  // Padrão oficial de containerização (docs/app/guides/self-hosting).
  output: "standalone",
  // pnpm usa symlinks em node_modules; sem tracingRoot explícito o file-tracing
  // do standalone pode perder deps e o server quebra em runtime. Fixa a raiz.
  outputFileTracingRoot: path.join(__dirname),
  // NOTA: o canal Slack do sreAgent depende do pacote `chat` (Vercel Chat SDK),
  // carregado por @mastra/core via import() dinâmico. O file-tracing do standalone
  // não enxerga essa cadeia; a closure é injetada na imagem pelo Dockerfile
  // (scripts/collect-chat-closure.mjs) em vez de outputFileTracingIncludes — que
  // não copia as deps transitivas por baixo dos symlinks do pnpm de forma confiável.
  // Build ID estável entre imagens/ambientes. Sem isto cada `next build` gera
  // um ID novo → version skew (assets 404, "Failed to find Server Action") em
  // rolling deploy. Injetado via CI (git SHA); cai no default se ausente.
  // `||` (não `??`) trata string VAZIA como ausente: `GIT_HASH: ${GIT_HASH:-}`
  // no compose vira "" quando não setado, e "" ?? x = "" geraria um BUILD_ID
  // vazio → runtime "Invariant: buildID is required". Retornar null deixa o
  // Next gerar um ID aleatório (o default correto).
  generateBuildId: async () =>
    process.env.GIT_HASH || process.env.SOURCE_COMMIT || null,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Hosts permitidos a acessar recursos de dev (HMR etc). Necessário quando o app
  // roda atrás de túnel (Cloudflare) sob outro domínio — sem isso o Next bloqueia
  // cross-origin e o WebSocket de HMR falha (502).
  allowedDevOrigins: ["casper.ultraself.com.br"],
  // Libs pesadas que rodam só no server; nunca empacotar no client bundle.
  serverExternalPackages: [
    "@mastra/core",
    "@mastra/memory",
    "@mastra/pg",
    "@mastra/inngest",
    // OTel/SigNoz exporter: loads the OTLP exporter packages via a runtime
    // `await import(variableSpec)`. Turbopack can't resolve a dynamic specifier
    // inside the server bundle → the import throws and the exporter silently
    // disables ("exporter is not installed"). Externalizing it (and the OTLP
    // exporters it pulls) makes the dynamic import resolve from node_modules.
    "@mastra/otel-exporter",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-trace-otlp-proto",
    "inngest",
    // better-auth puxa @better-auth/kysely-adapter (deps Node/sqlite) que quebra
    // o bundler. Externalizamos só o adapter+kysely; o pacote better-auth em si
    // (e better-auth/react no client) continua bundled para compartilhar o React
    // do app — externalizá-lo inteiro causa "two Reacts" (useRef null).
    "@better-auth/kysely-adapter",
    "kysely",
  ],
};

export default nextConfig;
