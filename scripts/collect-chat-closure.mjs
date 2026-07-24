// Coleta a closure de dependências do pacote `chat` (Vercel Chat SDK) e a copia
// para um diretório de staging, preservando o layout .pnpm (symlinks internos).
//
// Por quê: o canal Slack do sreAgent roda através da Chat SDK — `@mastra/core`
// carrega o pacote `chat` via `import('chat')` DINÂMICO. `@mastra/core` está em
// `serverExternalPackages`, então o file-tracing do `output: standalone` do Next
// não enxerga essa cadeia e poda a árvore inteira do `chat` (chat + remark/mdast/
// micromark, ~40 pacotes) da imagem. Em runtime isso quebra com ERR_MODULE_NOT_FOUND
// um pacote por vez. Aqui computamos a closure COMPLETA no build e a copiamos
// explícita para o runner — determinístico, sem whack-a-mole.
//
// Robustez: seguimos os SYMLINKS reais dentro de cada `.pnpm/<variant>/node_modules/`
// (não re-resolvemos por nome), então pegamos a variante peer-dep EXATA para a qual
// cada pacote aponta. Todo dir referenciado é copiado, então nenhum symlink irmão
// fica pendurado.
//
// Uso: node scripts/collect-chat-closure.mjs <OUT_DIR>
//   OUT_DIR default: /chat-closure/node_modules/.pnpm

import {
  readdirSync,
  existsSync,
  readlinkSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { join, normalize } from "node:path";

const pnpmDir = "node_modules/.pnpm";
const OUT = process.argv[2] || "/chat-closure/node_modules/.pnpm";
const ROOT_PKG = process.argv[3] || "chat";

/** Acha o dir .pnpm/<variant> que contém node_modules/<name>/package.json. */
function findVariant(name) {
  for (const e of readdirSync(pnpmDir)) {
    if (existsSync(join(pnpmDir, e, "node_modules", name, "package.json"))) {
      return e;
    }
  }
  return null;
}

const start = findVariant(ROOT_PKG);
if (!start) {
  console.error(`[chat-closure] pacote raiz "${ROOT_PKG}" não encontrado em ${pnpmDir}`);
  process.exit(1);
}

const seen = new Set();
const queue = [start];

/** Extrai o nome do dir .pnpm/<variant> de um alvo de symlink. */
function variantFromLink(dir, target) {
  // Absoluto/normalizado: .../.pnpm/<variant>/node_modules/<pkg>
  const norm = normalize(join(dir, target));
  const m = norm.match(/\.pnpm[/\\]([^/\\]+)[/\\]node_modules[/\\]/);
  return m ? m[1] : null;
}

/** Varre um node_modules/ atrás de symlinks de dep (trata escopos @x/y). */
function scan(dir) {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isSymbolicLink()) {
      const v = variantFromLink(dir, readlinkSync(p));
      if (v && !seen.has(v)) queue.push(v);
    } else if (it.isDirectory() && it.name.startsWith("@")) {
      // dir de escopo: os symlinks reais estão um nível abaixo
      scan(p);
    }
  }
}

while (queue.length) {
  const variant = queue.pop();
  if (seen.has(variant)) continue;
  seen.add(variant);
  scan(join(pnpmDir, variant, "node_modules"));
}

mkdirSync(OUT, { recursive: true });
let n = 0;
for (const v of seen) {
  // dereference:false preserva os symlinks internos do layout .pnpm.
  cpSync(join(pnpmDir, v), join(OUT, v), { recursive: true, dereference: false });
  n++;
}
console.log(`[chat-closure] ${n} dirs .pnpm da closure de "${ROOT_PKG}" copiados p/ ${OUT}`);
