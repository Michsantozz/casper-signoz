import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MeetingDynamics } from "@/server/recall/dynamics";
import type { StructuredUtterance } from "@/server/recall/media";

/**
 * generateMeetingHealthInsight — turns dynamics metrics + transcript into a
 * manager-facing insight via ONE Fireworks generateObject call. Contract:
 *  - null when there's no dynamics or no transcript (no LLM call);
 *  - on success, returns headline + summary + moments, carrying the ORIGINAL
 *    signal `kind` through by matching atSeconds (the LLM schema drops it);
 *  - best-effort: if generateObject throws (bad JSON from the model, network),
 *    it returns null and never propagates — enrichment must not break.
 *
 * generateObject and createChatModel are mocked (no real Fireworks call).
 */

const generateObject = vi.fn();
vi.mock("ai", () => ({ generateObject: (...a: unknown[]) => generateObject(...a) }));
vi.mock("@/mastra/model", () => ({ createChatModel: () => ({}) }));

// Imported after the mocks are registered.
const { generateMeetingHealthInsight } = await import(
  "@/server/recall/dynamics-insight"
);

function dynamics(
  moments: MeetingDynamics["moments"],
): MeetingDynamics {
  return {
    participants: [
      {
        name: "Ana",
        talkShare: 0.7,
        talkSeconds: 420,
        turns: 5,
        interruptionsMade: 2,
        interruptionsReceived: 0,
        longestTurnSeconds: 40,
      },
    ],
    totalTalkSeconds: 600,
    turnCount: 8,
    interruptions: 2,
    silenceSeconds: 5,
    balance: 0.4,
    moments,
  };
}

const transcript: StructuredUtterance[] = [
  {
    speaker: "Ana",
    start: 9,
    words: [
      { text: "we", start: 9, end: 9.3 },
      { text: "disagree", start: 9.3, end: 10 },
    ],
  },
  {
    speaker: "João",
    start: 10,
    words: [{ text: "no", start: 10, end: 10.4 }],
  },
];

beforeEach(() => {
  generateObject.mockReset();
});

describe("generateMeetingHealthInsight", () => {
  it("returns null (no LLM call) when dynamics is null", async () => {
    const out = await generateMeetingHealthInsight(null, transcript);
    expect(out).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("returns null (no LLM call) when there is no transcript", async () => {
    const d = dynamics([
      { kind: "interruption", atSeconds: 10, durationSeconds: 1, label: "x" },
    ]);
    expect(await generateMeetingHealthInsight(d, [])).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("maps a successful response and carries the signal kind through", async () => {
    generateObject.mockResolvedValue({
      object: {
        headline: "One voice dominates",
        summary: "Ana drove most of the conversation.",
        moments: [{ sourceIndex: 0, label: "Ana pushed back on João", tone: "tense" }],
      },
    });
    const d = dynamics([
      { kind: "interruption", atSeconds: 10, durationSeconds: 1, label: "raw" },
    ]);

    const out = await generateMeetingHealthInsight(d, transcript);
    expect(generateObject).toHaveBeenCalledOnce();
    expect(out?.headline).toBe("One voice dominates");
    expect(out?.moments).toHaveLength(1);
    // kind is not in the LLM schema — it must be recovered from the source moment.
    expect(out?.moments[0].kind).toBe("interruption");
    expect(out?.moments[0].tone).toBe("tense");
  });

  it("returns null when the model call throws (best-effort, never propagates)", async () => {
    generateObject.mockRejectedValue(new Error("bad JSON from model"));
    const d = dynamics([
      { kind: "silence", atSeconds: 5, durationSeconds: 4, label: "gap" },
    ]);
    // Must not throw.
    const out = await generateMeetingHealthInsight(d, transcript);
    expect(out).toBeNull();
  });

  it("drops an unmatched source id instead of inventing a moment", async () => {
    generateObject.mockResolvedValue({
      object: {
        headline: "h",
        summary: "s",
        moments: [{ sourceIndex: 999, label: "ghost", tone: "neutral" }],
      },
    });
    const d = dynamics([
      { kind: "monologue", atSeconds: 10, durationSeconds: 90, label: "m" },
    ]);
    const out = await generateMeetingHealthInsight(d, transcript);
    expect(out?.moments).toEqual([]);
  });
});
