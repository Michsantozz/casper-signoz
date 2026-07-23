// Cliente de teste do agente de reuniões via rota /api/meetings/chat.
// Mantém histórico entre turnos (passados como argv) e imprime texto + tool calls.
//
// Uso: node scripts/chat-meeting.mjs "mensagem" '[<historico-json>]'
import crypto from "node:crypto";

const COOKIE =
  "better-auth.session_token=NphvnG7H6qBtO2kMP7XNDdqdpF5be0rE.tAlicrIC6P1IDq2eTNQw3EqUBppzRV7C7hwE0y+QHuA=";
const URL = "http://localhost:3000/api/meetings/chat";

const text = process.argv[2];
const history = process.argv[3] ? JSON.parse(process.argv[3]) : [];

const messages = [
  ...history,
  { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] },
];

const res = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: COOKIE },
  body: JSON.stringify({ messages }),
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let assistantText = "";
const toolCalls = [];
const toolResults = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const json = line.slice(6).trim();
    if (!json || json === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(json);
    } catch {
      continue;
    }
    if (ev.type === "text-delta") assistantText += ev.delta ?? "";
    if (ev.type === "tool-input-available" || ev.type === "tool-call")
      toolCalls.push({ name: ev.toolName, input: ev.input ?? ev.args });
    if (ev.type === "tool-output-available" || ev.type === "tool-result")
      toolResults.push({ output: ev.output ?? ev.result });
  }
}

console.log("\n=== TOOL CALLS ===");
for (const t of toolCalls)
  console.log("→", t.name, JSON.stringify(t.input)?.slice(0, 200));
console.log("\n=== TOOL RESULTS ===");
for (const r of toolResults)
  console.log("←", JSON.stringify(r.output)?.slice(0, 400));
console.log("\n=== TEXTO ===");
console.log(assistantText);
