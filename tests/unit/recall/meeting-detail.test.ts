import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * getMeetingDetail — DURABLE-FIRST read for the notebook. Contract:
 *  - if the record has a persisted structured transcript, return it (+ the
 *    durable videoUrl) WITHOUT calling Recall — survives Recall's expiry;
 *  - otherwise fall back to Recall's signed artifacts (legacy/processing rows);
 *  - a persisted videoUrl still wins over the signed one in the fallback path.
 *
 * findMeetingRecord + recallFetch are mocked.
 */

const findMeetingRecord = vi.fn();
const recallFetch = vi.fn();

vi.mock("@/server/recall/meeting-repository", () => ({
  findMeetingRecord: (...a: unknown[]) => findMeetingRecord(...a),
}));
vi.mock("@/server/recall/client", () => ({
  recallFetch: (...a: unknown[]) => recallFetch(...a),
}));

async function load() {
  return import("@/server/recall/meeting-detail");
}

const persistedUtterance = {
  speaker: "Alice",
  start: 1,
  words: [{ text: "hi", start: 1, end: 2 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMeetingDetail — durable path", () => {
  it("returns the persisted transcript + video without hitting Recall", async () => {
    findMeetingRecord.mockResolvedValue({
      botId: "bot-1",
      transcriptStruct: [persistedUtterance],
      videoUrl: "https://cdn/meeting-bot-1.mp4",
    });

    const { getMeetingDetail } = await load();
    const detail = await getMeetingDetail("bot-1");

    expect(detail.transcript).toEqual([persistedUtterance]);
    expect(detail.videoUrl).toBe("https://cdn/meeting-bot-1.mp4");
    expect(detail.transcriptState).toBe("ready");
    // The whole point: Recall is NOT called when we have durable data.
    expect(recallFetch).not.toHaveBeenCalled();
  });
});

describe("getMeetingDetail — fallback path", () => {
  it("falls back to Recall's signed artifacts for a legacy row", async () => {
    findMeetingRecord.mockResolvedValue({
      botId: "bot-1",
      transcriptStruct: null,
      videoUrl: null,
    });
    recallFetch.mockResolvedValue({
      id: "bot-1",
      recordings: [
        {
          media_shortcuts: {
            transcript: {
              status: { code: "done" },
              data: { download_url: "https://recall/t.json" },
            },
            video_mixed: {
              status: { code: "done" },
              data: { download_url: "https://recall/signed.mp4" },
            },
          },
        },
      ],
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ json: async () => [] }) as unknown as typeof fetch;

    const { getMeetingDetail } = await load();
    const detail = await getMeetingDetail("bot-1");

    expect(recallFetch).toHaveBeenCalled();
    expect(detail.videoUrl).toBe("https://recall/signed.mp4");
    expect(detail.transcriptState).toBe("ready");
  });

  it("persisted videoUrl wins over Recall's signed URL in fallback", async () => {
    // No structured transcript (so we take the fallback path) but a durable
    // video was captured — the durable URL must still be preferred.
    findMeetingRecord.mockResolvedValue({
      botId: "bot-1",
      transcriptStruct: null,
      videoUrl: "https://cdn/durable.mp4",
    });
    recallFetch.mockResolvedValue({
      id: "bot-1",
      recordings: [
        {
          media_shortcuts: {
            video_mixed: {
              status: { code: "done" },
              data: { download_url: "https://recall/signed.mp4" },
            },
          },
        },
      ],
    });

    const { getMeetingDetail } = await load();
    const detail = await getMeetingDetail("bot-1");
    expect(detail.videoUrl).toBe("https://cdn/durable.mp4");
  });
});
