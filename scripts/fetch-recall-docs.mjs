// Baixa todos os docs do Recall.ai via MCP (list_docs + get_doc) e grava MD local.
// Uso: node scripts/fetch-recall-docs.mjs [--out caminho.md] [--split]
//   --split  grava um arquivo por doc em docs/recall/<slug>.md além do índice.
//
// Token e endpoint vêm do .claude.json (recall-ai project-scoped). Sobrescreva via env:
//   RECALL_MCP_URL, RECALL_MCP_TOKEN

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const URL_ = process.env.RECALL_MCP_URL || "https://us-east-1.recall.ai/mcp";
const TOKEN =
  process.env.RECALL_MCP_TOKEN || "e34627c213bf783f58ee8a6f0dcc0471b5ffa328";

const args = process.argv.slice(2);
const OUT =
  args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/recall/RECALL_DOCS.md";
const SPLIT = args.includes("--split");

// Chama um tool MCP via JSON-RPC sobre HTTP. Resposta vem como SSE (text/event-stream).
async function callTool(name, toolArgs) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: toolArgs },
    }),
  });
  const raw = await res.text();
  // Desembrulha SSE: cada bloco separado por linha em branco é um event;
  // dentro dele, linhas "data:" se concatenam. Pegamos o último event com JSON válido.
  let json;
  if (raw.includes("data:")) {
    const events = raw.split(/\n\n/);
    for (const ev of events) {
      const data = ev
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("");
      if (!data) continue;
      try {
        json = JSON.parse(data);
      } catch {
        /* event parcial — ignora */
      }
    }
    if (!json) throw new Error("nenhum event SSE parseável");
  } else {
    json = JSON.parse(raw);
  }
  if (json.error) throw new Error(JSON.stringify(json.error));
  const content = json.result?.content?.[0]?.text;
  if (json.result?.isError) throw new Error(content || "tool error");
  return content;
}

const telemetry = { intent: "export Recall.ai docs to local markdown for offline reference" };

async function main() {
  console.log("→ list_docs…");
  const indexRaw = await callTool("list_docs", { telemetry });
  const docs = JSON.parse(indexRaw).docs;
  console.log(`  ${docs.length} docs`);

  const sections = new Map(); // categoria -> [{title, slug, md}]
  let ok = 0;
  let fail = 0;

  for (const [i, doc] of docs.entries()) {
    process.stdout.write(`\r→ get_doc ${i + 1}/${docs.length}  ${doc.slug.padEnd(40).slice(0, 40)}`);
    let md = "";
    try {
      md = await callTool("get_doc", { slug: doc.slug, telemetry });
      ok++;
    } catch (e) {
      md = `> ⚠️ falha ao baixar: ${e.message}`;
      fail++;
    }
    if (!sections.has(doc.category)) sections.set(doc.category, []);
    sections.get(doc.category).push({ ...doc, md });

    if (SPLIT) {
      const p = join("docs/recall", `${doc.slug}.md`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `# ${doc.title}\n\n<${doc.url}>\n\n${md}\n`);
    }
  }
  console.log(`\n  ok=${ok} fail=${fail}`);

  // Monta o MD único com índice + corpo por categoria.
  let out = `# Recall.ai — Documentação (export local)\n\n`;
  out += `Gerado via MCP \`get_doc\`. ${docs.length} páginas. Fonte: <https://docs.recall.ai>\n\n`;
  out += `## Índice\n\n`;
  for (const [cat, list] of sections) {
    out += `### ${cat}\n\n`;
    for (const d of list) out += `- [${d.title}](#${d.slug}) — \`${d.slug}\`\n`;
    out += `\n`;
  }
  out += `\n---\n\n`;
  for (const [cat, list] of sections) {
    out += `# ${cat}\n\n`;
    for (const d of list) {
      out += `<a id="${d.slug}"></a>\n## ${d.title}\n\n`;
      out += `**slug:** \`${d.slug}\` · **fonte:** <${d.url}>\n\n`;
      out += `${d.md}\n\n---\n\n`;
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`✓ escrito ${OUT} (${(out.length / 1024).toFixed(0)} KB)`);
  if (SPLIT) console.log(`✓ arquivos individuais em docs/recall/`);
}

main().catch((e) => {
  console.error("\n✗", e);
  process.exit(1);
});
