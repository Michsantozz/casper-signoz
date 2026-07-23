import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Meetings recovery Server Actions — reprocessMeeting / cancelScheduledMeeting.
 * Security is the crux: both derive the userId from the SESSION and assert bot
 * ownership before doing anything. Contract:
 *  - no session → { ok:false, error:"unauthenticated" }, no work;
 *  - not owner → { ok:false, error:"not found or not accessible" }, no work;
 *  - reprocess (owner) → requeues under the user's scope + runs enrichMeeting;
 *  - cancel (owner) → DELETEs the bot on Recall + clears the dedup mapping.
 *
 * All server deps are mocked; we assert the ownership gate and the side effects.
 */

const requireUserId = vi.fn();
const assertBotOwner = vi.fn();
const requeueMeetingRecord = vi.fn();
const enableMeetingShare = vi.fn();
const disableMeetingShare = vi.fn();
const deleteMeetingRecord = vi.fn();
const updateMeetingRecord = vi.fn();
const findMeetingRecord = vi.fn();
const enrichMeeting = vi.fn();
const findBotByBotId = vi.fn();
const findBotByDedupKey = vi.fn();
const saveBotMapping = vi.fn();
const getOrCreateBotMapping = vi.fn();
const deleteBotMapping = vi.fn();
const defaultDedupKey = vi.fn();
const deleteObjectByUrl = vi.fn();
const recallFetch = vi.fn();
const generateBehaviorInsight = vi.fn();
const generateScreenInsight = vi.fn();
const getMeetingDetail = vi.fn();
const withUserScope = vi.fn((_u: string, fn: () => unknown) => fn());

// A stand-in for the ad-hoc-pool 507 error class the schedule action catches.
class RecallAdhocPoolError extends Error {}

vi.mock("@/features/auth/model/session", () => ({
  requireUserId: (...a: unknown[]) => requireUserId(...a),
}));
vi.mock("@/server/recall/ownership", () => ({
  assertBotOwner: (...a: unknown[]) => assertBotOwner(...a),
}));
vi.mock("@/server/recall/meeting-repository", () => ({
  requeueMeetingRecord: (...a: unknown[]) => requeueMeetingRecord(...a),
  enableMeetingShare: (...a: unknown[]) => enableMeetingShare(...a),
  disableMeetingShare: (...a: unknown[]) => disableMeetingShare(...a),
  deleteMeetingRecord: (...a: unknown[]) => deleteMeetingRecord(...a),
  updateMeetingRecord: (...a: unknown[]) => updateMeetingRecord(...a),
  findMeetingRecord: (...a: unknown[]) => findMeetingRecord(...a),
}));
vi.mock("@/server/recall/enrich", () => ({
  enrichMeeting: (...a: unknown[]) => enrichMeeting(...a),
}));
vi.mock("@/server/recall/bot-repository", () => ({
  findBotByBotId: (...a: unknown[]) => findBotByBotId(...a),
  findBotByDedupKey: (...a: unknown[]) => findBotByDedupKey(...a),
  saveBotMapping: (...a: unknown[]) => saveBotMapping(...a),
  getOrCreateBotMapping: (...a: unknown[]) => getOrCreateBotMapping(...a),
  deleteBotMapping: (...a: unknown[]) => deleteBotMapping(...a),
  defaultDedupKey: (...a: unknown[]) => defaultDedupKey(...a),
}));
vi.mock("@/server/storage/s3", () => ({
  deleteObjectByUrl: (...a: unknown[]) => deleteObjectByUrl(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
  RecallAdhocPoolError,
}));
vi.mock("@/server/recall/behavior-insight", () => ({
  generateBehaviorInsight: (...a: unknown[]) => generateBehaviorInsight(...a),
}));
vi.mock("@/server/recall/screen-insight", () => ({
  generateScreenInsight: (...a: unknown[]) => generateScreenInsight(...a),
}));
vi.mock("@/server/recall/meeting-detail", () => ({
  getMeetingDetail: (...a: unknown[]) => getMeetingDetail(...a),
}));
vi.mock("@/shared/db/rls", () => ({
  withUserScope: (u: string, fn: () => unknown) => withUserScope(u, fn),
}));

async function load() {
  return import("@/features/meetings/api/actions");
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("u1");
  assertBotOwner.mockResolvedValue(undefined);
  enrichMeeting.mockResolvedValue({ state: "done" });
  findBotByBotId.mockResolvedValue({ dedupKey: "dk-1" });
  recallFetch.mockResolvedValue(undefined);
  generateBehaviorInsight.mockResolvedValue({
    headline: "h",
    summary: "s",
    moments: [],
  });
  generateScreenInsight.mockResolvedValue({ headline: "h", captures: [] });
  getMeetingDetail.mockResolvedValue({ transcript: [] });
  // Edit/delete/schedule defaults (owner + happy paths).
  deleteMeetingRecord.mockResolvedValue({ botId: "bot-1", videoUrl: null });
  updateMeetingRecord.mockResolvedValue({ botId: "bot-1" });
  findMeetingRecord.mockResolvedValue({ botId: "bot-1" });
  findBotByDedupKey.mockResolvedValue(null);
  saveBotMapping.mockResolvedValue(undefined);
  getOrCreateBotMapping.mockImplementation(async (input) => {
    const existing = await findBotByDedupKey(input.dedupKey);
    if (existing) return { row: existing, created: false };
    const bot = await input.createBot();
    await saveBotMapping({ ...input, botId: bot.id, createBot: undefined });
    return {
      row: {
        botId: bot.id,
        dedupKey: input.dedupKey,
        meetingUrl: input.meetingUrl,
        joinAt: input.joinAt ?? null,
        metadata: input.metadata,
      },
      created: true,
    };
  });
  defaultDedupKey.mockReturnValue("dk-1");
  deleteObjectByUrl.mockResolvedValue(true);
});

describe("reprocessMeeting", () => {
  it("owner → requeues under user scope and runs enrichMeeting", async () => {
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(assertBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(requeueMeetingRecord).toHaveBeenCalledWith("bot-1", "manual reprocess");
    expect(enrichMeeting).toHaveBeenCalledWith("bot-1");
  });

  it("not owner → refuses without requeue/enrich", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("someone-elses");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(requeueMeetingRecord).not.toHaveBeenCalled();
    expect(enrichMeeting).not.toHaveBeenCalled();
  });

  it("no session → unauthenticated, no work", async () => {
    requireUserId.mockRejectedValue(new Error("unauthenticated"));
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(requeueMeetingRecord).not.toHaveBeenCalled();
  });

  it("enrich still failed → surfaces the error", async () => {
    enrichMeeting.mockResolvedValue({ state: "failed", error: "empty transcript" });
    const { reprocessMeeting } = await load();
    const res = await reprocessMeeting("bot-1");
    expect(res).toEqual({ ok: false, error: "empty transcript" });
  });
});

describe("cancelScheduledMeeting", () => {
  it("owner → DELETEs the bot on Recall and clears the mapping", async () => {
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(recallFetch).toHaveBeenCalledWith({
      method: "DELETE",
      path: "v1/bot/bot-1/",
    });
    expect(deleteBotMapping).toHaveBeenCalledWith("dk-1");
  });

  it("not owner → refuses without calling Recall", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("someone-elses");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(recallFetch).not.toHaveBeenCalled();
    expect(deleteBotMapping).not.toHaveBeenCalled();
  });

  it("Recall DELETE fails → returns the error, no mapping delete", async () => {
    recallFetch.mockRejectedValue(new Error("recall 500"));
    const { cancelScheduledMeeting } = await load();
    const res = await cancelScheduledMeeting("bot-1");

    expect(res.ok).toBe(false);
    expect(deleteBotMapping).not.toHaveBeenCalled();
  });
});

describe("setMeetingShare — public share-link toggle", () => {
  it("unauthenticated → rejected, share never touched", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(enableMeetingShare).not.toHaveBeenCalled();
    expect(disableMeetingShare).not.toHaveBeenCalled();
  });

  it("non-owner → refused, share never enabled (no public leak)", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(enableMeetingShare).not.toHaveBeenCalled();
  });

  it("owner enable → mints a token under user scope", async () => {
    enableMeetingShare.mockResolvedValue({ shareToken: "tok-abc" });
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: true, shareToken: "tok-abc" });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(enableMeetingShare).toHaveBeenCalledWith("bot-1");
  });

  it("owner disable → clears the token, returns null", async () => {
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", false);

    expect(res).toEqual({ ok: true, shareToken: null });
    expect(disableMeetingShare).toHaveBeenCalledWith("bot-1");
    expect(enableMeetingShare).not.toHaveBeenCalled();
  });

  it("enable but the meeting vanished → not-accessible, no token returned", async () => {
    enableMeetingShare.mockResolvedValue(null);
    const { setMeetingShare } = await load();

    const res = await setMeetingShare("bot-1", true);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
  });
});

describe("analyzeMeetingBehavior — client-triggered behavioral read", () => {
  const moments = [
    {
      atSeconds: 10,
      kind: "interruption" as const,
      label: "Ana cut off João",
      intensity: 0.8,
      isTense: true,
    },
  ];
  const metrics = {
    balance: 0.4,
    interruptions: 3,
    silenceSeconds: 8,
    participants: [
      { name: "Ana", talkShare: 0.7, interruptionsMade: 2, longestTurnSeconds: 40 },
    ],
  };

  it("unauthenticated → rejected, no LLM read", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { analyzeMeetingBehavior } = await load();

    const res = await analyzeMeetingBehavior("bot-1", moments, metrics);

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(generateBehaviorInsight).not.toHaveBeenCalled();
  });

  it("non-owner → refused, no LLM read (no cross-tenant analysis)", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    const { analyzeMeetingBehavior } = await load();

    const res = await analyzeMeetingBehavior("someone-elses", moments, metrics);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(generateBehaviorInsight).not.toHaveBeenCalled();
  });

  it("owner → runs the read and returns the insight", async () => {
    const insight = {
      headline: "Tense standoff",
      summary: "Ana dominated.",
      moments: [{ atSeconds: 10, read: "Ana cut in", behavior: "conflict" as const }],
    };
    generateBehaviorInsight.mockResolvedValue(insight);
    const { analyzeMeetingBehavior } = await load();

    const res = await analyzeMeetingBehavior("bot-1", moments, metrics);

    expect(res).toEqual({ ok: true, insight });
    expect(assertBotOwner).toHaveBeenCalledWith("bot-1", "u1");
    expect(generateBehaviorInsight).toHaveBeenCalledWith(moments, metrics);
  });

  it("owner but nothing tense → ok with null insight", async () => {
    generateBehaviorInsight.mockResolvedValue(null);
    const { analyzeMeetingBehavior } = await load();

    const res = await analyzeMeetingBehavior("bot-1", moments, metrics);

    expect(res).toEqual({ ok: true, insight: null });
  });

  it("LLM read throws → surfaces the error, never propagates", async () => {
    generateBehaviorInsight.mockRejectedValue(new Error("model down"));
    const { analyzeMeetingBehavior } = await load();

    const res = await analyzeMeetingBehavior("bot-1", moments, metrics);

    expect(res).toEqual({ ok: false, error: "model down" });
  });
});

describe("analyzeMeetingScreens — vision over shared-screen frames", () => {
  const frames = [
    { url: "https://store/a.jpg", atSeconds: 120, trigger: "screen-start" as const },
  ];

  it("unauthenticated → rejected, no transcript read, no vision", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { analyzeMeetingScreens } = await load();

    const res = await analyzeMeetingScreens("bot-1", frames);

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(getMeetingDetail).not.toHaveBeenCalled();
    expect(generateScreenInsight).not.toHaveBeenCalled();
  });

  it("non-owner → refused, no vision (no cross-tenant analysis)", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    const { analyzeMeetingScreens } = await load();

    const res = await analyzeMeetingScreens("someone-elses", frames);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(generateScreenInsight).not.toHaveBeenCalled();
  });

  it("no frames → ok with null, no vision call", async () => {
    const { analyzeMeetingScreens } = await load();

    const res = await analyzeMeetingScreens("bot-1", []);

    expect(res).toEqual({ ok: true, insight: null });
    expect(generateScreenInsight).not.toHaveBeenCalled();
  });

  it("owner → builds excerpts under user scope and runs vision", async () => {
    getMeetingDetail.mockResolvedValue({
      transcript: [
        {
          speaker: "Ana",
          words: [
            { text: "olha", start: 118 },
            { text: "esse", start: 119 },
            { text: "número", start: 120 },
          ],
        },
        // Far from the frame → must NOT be in the excerpt.
        { speaker: "João", words: [{ text: "tchau", start: 500 }] },
      ],
    });
    const insight = { headline: "1 screen", captures: [] };
    generateScreenInsight.mockResolvedValue(insight);
    const { analyzeMeetingScreens } = await load();

    const res = await analyzeMeetingScreens("bot-1", frames);

    expect(res).toEqual({ ok: true, insight });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    // The frame passed to vision carries the grounding excerpt near atSeconds 120.
    const passed = generateScreenInsight.mock.calls[0][0];
    expect(passed[0].excerpt).toContain("olha");
    expect(passed[0].excerpt).not.toContain("tchau");
  });

  it("vision throws → surfaces the error, never propagates", async () => {
    generateScreenInsight.mockRejectedValue(new Error("vision down"));
    const { analyzeMeetingScreens } = await load();

    const res = await analyzeMeetingScreens("bot-1", frames);

    expect(res).toEqual({ ok: false, error: "vision down" });
  });
});

describe("deleteMeeting — permanent removal", () => {
  it("unauthenticated → rejected, nothing deleted", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { deleteMeeting } = await load();

    const res = await deleteMeeting("bot-1");

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(assertBotOwner).not.toHaveBeenCalled();
    expect(deleteMeetingRecord).not.toHaveBeenCalled();
  });

  it("non-owner → refused, no delete (no cross-tenant removal)", async () => {
    assertBotOwner.mockRejectedValue(new Error("not accessible"));
    const { deleteMeeting } = await load();

    const res = await deleteMeeting("someone-elses");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(deleteMeetingRecord).not.toHaveBeenCalled();
    expect(deleteObjectByUrl).not.toHaveBeenCalled();
  });

  it("owner → deletes record under scope, reclaims video, clears mapping", async () => {
    deleteMeetingRecord.mockResolvedValue({
      botId: "bot-1",
      videoUrl: "https://store/uploads/u1/v.mp4",
    });
    findBotByBotId.mockResolvedValue({ dedupKey: "dk-x" });
    const { deleteMeeting } = await load();

    const res = await deleteMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(deleteMeetingRecord).toHaveBeenCalledWith("bot-1");
    expect(deleteObjectByUrl).toHaveBeenCalledWith(
      "https://store/uploads/u1/v.mp4",
    );
    expect(deleteBotMapping).toHaveBeenCalledWith("dk-x");
  });

  it("owner but record had no video → no storage reclaim", async () => {
    deleteMeetingRecord.mockResolvedValue({ botId: "bot-1", videoUrl: null });
    findBotByBotId.mockResolvedValue(null);
    const { deleteMeeting } = await load();

    const res = await deleteMeeting("bot-1");

    expect(res).toEqual({ ok: true });
    expect(deleteObjectByUrl).not.toHaveBeenCalled();
    expect(deleteBotMapping).not.toHaveBeenCalled();
  });
});

describe("updateMeetingSummary — owner edit of the generated text", () => {
  it("non-owner → refused, no write", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { updateMeetingSummary } = await load();

    const res = await updateMeetingSummary("bot-1", "s", "o");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(updateMeetingRecord).not.toHaveBeenCalled();
  });

  it("owner → writes trimmed summary/overview under scope", async () => {
    const { updateMeetingSummary } = await load();

    const res = await updateMeetingSummary("bot-1", " New summary ", " ov ");

    expect(res).toEqual({ ok: true });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(updateMeetingRecord).toHaveBeenCalledWith("bot-1", {
      summary: "New summary",
      overview: "ov",
    });
  });

  it("blank strings clear the fields (stored as null)", async () => {
    const { updateMeetingSummary } = await load();

    await updateMeetingSummary("bot-1", "   ", "");

    expect(updateMeetingRecord).toHaveBeenCalledWith("bot-1", {
      summary: null,
      overview: null,
    });
  });

  it("record vanished mid-edit → not-accessible", async () => {
    updateMeetingRecord.mockResolvedValue(null);
    const { updateMeetingSummary } = await load();

    const res = await updateMeetingSummary("bot-1", "s", "o");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
  });
});

describe("updateMeetingActionItems — owner edit of the task list", () => {
  it("non-owner → refused, no write", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { updateMeetingActionItems } = await load();

    const res = await updateMeetingActionItems("bot-1", [
      { task: "x", owner: null },
    ]);

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(updateMeetingRecord).not.toHaveBeenCalled();
  });

  it("owner → drops blank tasks, trims owners to null", async () => {
    const { updateMeetingActionItems } = await load();

    const res = await updateMeetingActionItems("bot-1", [
      { task: "  Ship it  ", owner: "  Ana  " },
      { task: "   ", owner: "ghost" }, // blank task → dropped
      { task: "Review", owner: "  " }, // blank owner → null
    ]);

    expect(res).toEqual({ ok: true });
    expect(updateMeetingRecord).toHaveBeenCalledWith("bot-1", {
      actionItems: [
        { task: "Ship it", owner: "Ana" },
        { task: "Review", owner: null },
      ],
    });
  });
});

describe("renameMeetingSpeaker — relabels across the meeting", () => {
  it("non-owner → refused, no read/write", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { renameMeetingSpeaker } = await load();

    const res = await renameMeetingSpeaker("bot-1", "Speaker 1", "Ana");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(findMeetingRecord).not.toHaveBeenCalled();
    expect(updateMeetingRecord).not.toHaveBeenCalled();
  });

  it("empty new name → rejected", async () => {
    const { renameMeetingSpeaker } = await load();

    const res = await renameMeetingSpeaker("bot-1", "Speaker 1", "   ");

    expect(res).toEqual({ ok: false, error: "name required" });
    expect(findMeetingRecord).not.toHaveBeenCalled();
  });

  it("owner → rewrites the label in transcript, talkShares and dynamics", async () => {
    findMeetingRecord.mockResolvedValue({
      transcriptStruct: [
        { speaker: "Speaker 1", start: 0, words: [] },
        { speaker: "Ana", start: 5, words: [] },
      ],
      talkShares: [
        { name: "Speaker 1", share: 0.6 },
        { name: "Ana", share: 0.4 },
      ],
      dynamics: {
        participants: [{ name: "Speaker 1" }, { name: "Ana" }],
        balance: 0.5,
      },
    });
    const { renameMeetingSpeaker } = await load();

    const res = await renameMeetingSpeaker("bot-1", "Speaker 1", "João");

    expect(res).toEqual({ ok: true });
    expect(withUserScope).toHaveBeenCalledWith("u1", expect.any(Function));
    const [, patch] = updateMeetingRecord.mock.calls[0];
    // Renamed everywhere it matched; the other speaker is untouched.
    expect(patch.transcriptStruct[0].speaker).toBe("João");
    expect(patch.transcriptStruct[1].speaker).toBe("Ana");
    expect(patch.talkShares[0].name).toBe("João");
    expect(patch.dynamics.participants[0].name).toBe("João");
    expect(patch.dynamics.participants[1].name).toBe("Ana");
  });

  it("owner but record vanished → not-accessible", async () => {
    findMeetingRecord.mockResolvedValue(null);
    const { renameMeetingSpeaker } = await load();

    const res = await renameMeetingSpeaker("bot-1", "Speaker 1", "Ana");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(updateMeetingRecord).not.toHaveBeenCalled();
  });
});

describe("updateMeetingTitle — owner display title", () => {
  it("non-owner → refused, no write", async () => {
    assertBotOwner.mockRejectedValue(new Error("nope"));
    const { updateMeetingTitle } = await load();

    const res = await updateMeetingTitle("bot-1", "Kickoff");

    expect(res).toEqual({ ok: false, error: "not found or not accessible" });
    expect(updateMeetingRecord).not.toHaveBeenCalled();
  });

  it("owner → writes the trimmed title under scope", async () => {
    const { updateMeetingTitle } = await load();

    const res = await updateMeetingTitle("bot-1", "  Kickoff  ");

    expect(res).toEqual({ ok: true });
    expect(updateMeetingRecord).toHaveBeenCalledWith("bot-1", {
      title: "Kickoff",
    });
  });

  it("blank title clears it (null)", async () => {
    const { updateMeetingTitle } = await load();

    await updateMeetingTitle("bot-1", "   ");

    expect(updateMeetingRecord).toHaveBeenCalledWith("bot-1", { title: null });
  });
});

describe("scheduleMeetingBot — send a bot from the UI", () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("unauthenticated → rejected, no Recall call", async () => {
    requireUserId.mockRejectedValue(new Error("no session"));
    const { scheduleMeetingBot } = await load();

    const res = await scheduleMeetingBot({ meetingUrl: "https://meet/x" });

    expect(res).toEqual({ ok: false, error: "unauthenticated" });
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("empty URL → rejected", async () => {
    const { scheduleMeetingBot } = await load();
    const res = await scheduleMeetingBot({ meetingUrl: "   " });
    expect(res).toEqual({ ok: false, error: "meeting URL required" });
  });

  it("malformed URL → rejected", async () => {
    const { scheduleMeetingBot } = await load();
    const res = await scheduleMeetingBot({ meetingUrl: "not a url" });
    expect(res).toEqual({ ok: false, error: "invalid meeting URL" });
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("join time in the past → rejected", async () => {
    const { scheduleMeetingBot } = await load();
    const res = await scheduleMeetingBot({
      meetingUrl: "https://meet/x",
      joinAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(res).toEqual({ ok: false, error: "join time must be in the future" });
  });

  it("existing bot for this meeting → reused, no new bot created", async () => {
    findBotByDedupKey.mockResolvedValue({ botId: "existing", joinAt: null });
    const { scheduleMeetingBot } = await load();

    const res = await scheduleMeetingBot({ meetingUrl: "https://meet/x" });

    expect(res).toEqual({
      ok: true,
      botId: "existing",
      scheduled: false,
      reused: true,
    });
    expect(recallFetch).not.toHaveBeenCalled();
  });

  it("ad-hoc join now → creates the bot and saves the mapping", async () => {
    recallFetch.mockResolvedValue({ id: "bot-new" });
    const { scheduleMeetingBot } = await load();

    const res = await scheduleMeetingBot({
      meetingUrl: "https://meet.google.com/abc",
    });

    expect(res).toEqual({
      ok: true,
      botId: "bot-new",
      scheduled: false,
      reused: false,
    });
    expect(recallFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "v1/bot/" }),
    );
    expect(saveBotMapping).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot-new" }),
    );
  });

  it("scheduled (future join_at) → scheduled=true, join_at forwarded", async () => {
    recallFetch.mockResolvedValue({ id: "bot-s" });
    const at = future();
    const { scheduleMeetingBot } = await load();

    const res = await scheduleMeetingBot({
      meetingUrl: "https://meet/x",
      joinAt: at,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.scheduled).toBe(true);
    const [call] = recallFetch.mock.calls;
    expect(call[0].body.join_at).toBe(at);
  });

  it("ad-hoc pool exhausted → friendly error, no mapping saved", async () => {
    recallFetch.mockRejectedValue(new RecallAdhocPoolError("507"));
    const { scheduleMeetingBot } = await load();

    const res = await scheduleMeetingBot({ meetingUrl: "https://meet/x" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ad-hoc bot pool exhausted/i);
    expect(saveBotMapping).not.toHaveBeenCalled();
  });
});
