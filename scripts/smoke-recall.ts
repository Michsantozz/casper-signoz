/**
 * Smoke test das tools Recall: schedule -> dedup no DB -> reuse -> get -> cancel.
 * Roda contra a API real do Recall (testnet workspace) + Postgres local.
 *
 * Uso: set -a && . ./.env && set +a && node_modules/.bin/tsx scripts/smoke-recall.ts
 */
import {
  scheduleRecallBotTool,
  getRecallBotTool,
  cancelRecallBotTool,
} from "../src/mastra/tools/recall.tool";
import { findBotByDedupKey } from "../src/server/recall/bot-repository";

const run = (tool: any, ctx: any) => tool.execute(ctx);

async function main() {
  // join_at 30min no futuro -> scheduled (join garantido, não toca pool ad-hoc).
  const joinAt = new Date(Date.now() + 30 * 60_000).toISOString();
  // Formato Google Meet válido: xxx-xxxx-xxx (letras minúsculas).
  const rand = (n: number) =>
    Array.from({ length: n }, () =>
      "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)],
    ).join("");
  const meetingUrl = `https://meet.google.com/${rand(3)}-${rand(4)}-${rand(3)}`;

  console.log("1) schedule_recall_bot (scheduled)…");
  const r1 = await run(scheduleRecallBotTool, {
    meetingUrl,
    joinAt,
    botName: "Casper Smoke Bot",
  });
  console.log("   ->", r1);
  if (!r1.ok || r1.reused) throw new Error("esperava criação nova");

  console.log("2) dedup gravado no Postgres?");
  const row = await findBotByDedupKey(r1.dedupKey);
  console.log("   ->", row);
  if (!row || row.botId !== r1.botId) throw new Error("mapping não persistiu");

  console.log("3) schedule de novo (mesma URL+horário) -> deve REUSAR…");
  const r2 = await run(scheduleRecallBotTool, { meetingUrl, joinAt });
  console.log("   ->", r2);
  if (!r2.reused || r2.botId !== r1.botId) throw new Error("dedup falhou");

  console.log("4) get_recall_bot…");
  const r3 = await run(getRecallBotTool, { botId: r1.botId });
  console.log("   ->", r3);

  console.log("5) cancel_recall_bot (unschedule + limpa mapping)…");
  const r4 = await run(cancelRecallBotTool, {
    botId: r1.botId,
    dedupKey: r1.dedupKey,
  });
  console.log("   ->", r4);

  const gone = await findBotByDedupKey(r1.dedupKey);
  if (gone) throw new Error("mapping não foi limpo no cancel");

  console.log("\n✅ smoke OK — schedule, dedup, reuse, get, cancel/cleanup");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ smoke FAIL:", e);
  process.exit(1);
});
