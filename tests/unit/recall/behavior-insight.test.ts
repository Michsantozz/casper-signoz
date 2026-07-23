import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  BehaviorMomentInput,
  BehaviorMetricsInput,
} from "@/server/recall/behavior-insight";

/**
 * generateBehaviorInsight — reads the HUMAN BEHAVIOR behind the client-computed
 * acoustic tension moments via ONE Fireworks generateObject call. Contract:
 *  - null when there are NO tense moments (nothing to read → no LLM call);
 *  - only the isTense moments are sent, ranked by intensity, capped at 10;
 *  - on success, returns headline + summary + moments verbatim from the model;
 *  - best-effort: if generateObject throws (bad JSON, network), returns null and
 *    never propagates — the client's tension overlay stands on its own.
 *
 * generateObject and createChatModel are mocked (no real Fireworks call).
 */

const generateObject = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...a: unknown[]) => generateObject(...a),
}));
vi.mock("@/mastra/model", () => ({ createChatModel: () => ({}) }));

const { generateBehaviorInsight } = await import(
  "@/server/recall/behavior-insight"
);

const metrics: BehaviorMetricsInput = {
  balance: 0.4,
  interruptions: 3,
  silenceSeconds: 8,
  participants: [
    { name: "Ana", talkShare: 0.7, interruptionsMade: 2, longestTurnSeconds: 40 },
    { name: "João", talkShare: 0.3, interruptionsMade: 1, longestTurnSeconds: 12 },
  ],
};

function moment(
  over: Partial<BehaviorMomentInput> = {},
): BehaviorMomentInput {
  return {
    atSeconds: 10,
    kind: "interruption",
    label: "Ana cut off João",
    intensity: 0.8,
    isTense: true,
    ...over,
  };
}

beforeEach(() => {
  generateObject.mockReset();
});

describe("generateBehaviorInsight", () => {
  it("returns null (no LLM call) when there are no moments at all", async () => {
    const out = await generateBehaviorInsight([], metrics);
    expect(out).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("returns null (no LLM call) when no moment is tense", async () => {
    const out = await generateBehaviorInsight(
      [moment({ isTense: false }), moment({ atSeconds: 20, isTense: false })],
      metrics,
    );
    expect(out).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("maps a successful response verbatim", async () => {
    generateObject.mockResolvedValue({
      object: {
        headline: "Tense budget standoff",
        summary: "Ana pushed hard; João pushed back and disengaged.",
        moments: [
          { atSeconds: 10, read: "Ana cut in aggressively", behavior: "conflict" },
        ],
      },
    });

    const out = await generateBehaviorInsight([moment()], metrics);
    expect(generateObject).toHaveBeenCalledOnce();
    expect(out?.headline).toBe("Tense budget standoff");
    expect(out?.moments).toHaveLength(1);
    expect(out?.moments[0].behavior).toBe("conflict");
    expect(out?.moments[0].read).toBe("Ana cut in aggressively");
  });

  it("sends only tense moments, ranked by intensity and capped at 10", async () => {
    generateObject.mockResolvedValue({
      object: { headline: "h", summary: "s", moments: [] },
    });

    // 12 tense + 2 non-tense. Expect exactly 10 tense sent, highest intensity first.
    const tense = Array.from({ length: 12 }, (_, i) =>
      moment({ atSeconds: i, intensity: i / 12, isTense: true }),
    );
    const flat = [
      moment({ atSeconds: 100, isTense: false }),
      moment({ atSeconds: 101, isTense: false }),
    ];

    await generateBehaviorInsight([...tense, ...flat], metrics);

    const prompt = generateObject.mock.calls[0][0].prompt as string;
    // Non-tense seconds must be absent.
    expect(prompt).not.toContain("[100s]");
    expect(prompt).not.toContain("[101s]");
    // Highest-intensity moment (atSeconds 11) is present; the two lowest dropped.
    expect(prompt).toContain("[11s]");
    expect(prompt).not.toContain("[0s]");
    expect(prompt).not.toContain("[1s]");
    // Exactly 10 moment lines (one "[Ns]" bracket each).
    const bracketed = (prompt.match(/\[\d+s\]/g) ?? []).length;
    expect(bracketed).toBe(10);
  });

  it("returns null when the model call throws (best-effort, never propagates)", async () => {
    generateObject.mockRejectedValue(new Error("bad JSON from model"));
    const out = await generateBehaviorInsight([moment()], metrics);
    expect(out).toBeNull();
  });
});
