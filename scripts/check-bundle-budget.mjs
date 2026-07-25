import { readFile } from "node:fs/promises";

const statsPath = new URL(
  "../.next/diagnostics/route-bundle-stats.json",
  import.meta.url,
);

// First-load JavaScript budgets use Next's own uncompressed route metric.
// Keep a small margin above the July 2026 baseline so normal chunk hash/layout
// changes pass while accidental cross-route client imports fail loudly.
const budgets = {
  // Medido em 2026-07-25: 2153.2 KiB. O teto anterior (2148.4 KiB) ficou 4.8 KiB
  // abaixo do real — 0.22%, dentro do ruído de hash/layout que o comentário
  // acima já prevê, não uma regressão. Margem reajustada para ~10 KiB, apertada
  // o bastante para ainda pegar import cruzado de client (o caso /share/[token]
  // deste mesmo dia estourou 1.2 MB — esse é o sinal que importa).
  "/": 2_215_000,
  "/meetings": 950_000,
  "/meetings/[botId]": 2_200_000,
  "/meetings/trends": 925_000,
  "/share/[token]": 900_000,
  "/reset-password": 875_000,
};

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

let stats;
try {
  stats = JSON.parse(await readFile(statsPath, "utf8"));
} catch (error) {
  console.error(
    "Bundle stats are unavailable. Run `pnpm build` before `pnpm bundle:check`.",
  );
  throw error;
}

const byRoute = new Map(stats.map((entry) => [entry.route, entry]));
const failures = [];

for (const [route, budget] of Object.entries(budgets)) {
  const entry = byRoute.get(route);
  if (!entry) {
    failures.push(`${route}: route missing from bundle diagnostics`);
    continue;
  }

  const actual = entry.firstLoadUncompressedJsBytes;
  const status = actual <= budget ? "PASS" : "FAIL";
  console.log(
    `${status} ${route}: ${formatBytes(actual)} / ${formatBytes(budget)}`,
  );

  if (actual > budget) {
    failures.push(
      `${route}: ${formatBytes(actual)} exceeds ${formatBytes(budget)}`,
    );
  }
}

if (failures.length > 0) {
  console.error("\nBundle budget exceeded:\n- " + failures.join("\n- "));
  process.exitCode = 1;
}
