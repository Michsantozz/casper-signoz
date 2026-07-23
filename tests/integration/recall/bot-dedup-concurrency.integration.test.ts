import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { getOrCreateBotMapping } from "@/server/recall/bot-repository";

const LIVE = process.env.RUN_LIVE_E2E === "1";
const URL = process.env.DATABASE_URL ?? "";
const KEY = `__bot_dedup_conc_test__${process.pid}`;

async function cleanup() {
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`delete from recall_bots where dedup_key=$1`, [KEY]);
  } finally {
    await client.end();
  }
}

describe.skipIf(!LIVE)("bot creation deduplication (live pg)", () => {
  afterAll(cleanup);

  it("executes the provider create callback exactly once across concurrent callers", async () => {
    await cleanup();
    let creates = 0;
    const createBot = async () => {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { id: "provider-bot-once" };
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        getOrCreateBotMapping({
          dedupKey: KEY,
          meetingUrl: "https://meet.example/concurrency",
          metadata: { user_id: "test-owner" },
          createBot,
        }),
      ),
    );

    expect(creates).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.row.botId))).toEqual(
      new Set(["provider-bot-once"]),
    );
  });
});
