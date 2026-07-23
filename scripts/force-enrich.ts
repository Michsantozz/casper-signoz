/**
 * Force-enrich one meeting bypassing Inngest.
 *
 * Recovery tool: when Inngest is down, the bot webhook enqueues the
 * meeting_records row but the meeting-enrich workflow never fires, so the row
 * stays `pending` with no summary. This calls enrichMeeting() directly (the same
 * durable worker the workflow wraps) to pull the transcript from Recall, generate
 * minutes + dynamics + insight, and persist — no Inngest needed.
 *
 * Env is passed in by the caller (see the wrapper command), so no dotenv dep.
 *
 * Usage: pnpm tsx scripts/force-enrich.ts <botId>
 */
async function main() {
  const botId = process.argv[2];
  if (!botId) {
    console.error("usage: pnpm tsx scripts/force-enrich.ts <botId>");
    process.exit(1);
  }

  const { enrichMeeting } = await import("@/server/recall/enrich");

  console.log(`[force-enrich] starting for bot ${botId} ...`);
  const result = await enrichMeeting(botId);
  console.log(`[force-enrich] result:`, JSON.stringify(result, null, 2));
  process.exit(result.state === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("[force-enrich] crashed:", err);
  process.exit(1);
});
