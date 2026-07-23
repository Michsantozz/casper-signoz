import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ScreenFrameInput } from "@/server/recall/screen-insight";

/**
 * generateScreenInsight — the vision layer. Reads each shared-screen frame with
 * one vision call, extracting what's literally on screen. Contract:
 *  - null when there are no frames (no vision call);
 *  - one generateObject call per frame, each with an image content part + the
 *    transcript excerpt;
 *  - a frame whose vision call throws is dropped (best-effort), not fatal;
 *  - null when EVERY frame fails to read;
 *  - captures are ranked by how informative the screen kind is (dashboard first).
 *
 * generateObject and createChatModel are mocked (no real vision call).
 */

const generateObject = vi.fn();
vi.mock("ai", () => ({
  generateObject: (...a: unknown[]) => generateObject(...a),
}));
vi.mock("@/mastra/model", () => ({ createChatModel: () => ({}) }));

const { generateScreenInsight } = await import(
  "@/server/recall/screen-insight"
);

function frame(over: Partial<ScreenFrameInput> = {}): ScreenFrameInput {
  return {
    url: "https://store/frame.jpg",
    atSeconds: 120,
    trigger: "screen-start",
    excerpt: "Ana: olha esse número",
    ...over,
  };
}

beforeEach(() => {
  generateObject.mockReset();
});

describe("generateScreenInsight", () => {
  it("returns null (no vision call) when there are no frames", async () => {
    const out = await generateScreenInsight([]);
    expect(out).toBeNull();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("reads each frame with an image content part + the excerpt", async () => {
    generateObject.mockResolvedValue({
      object: {
        kind: "dashboard",
        title: "Q3 churn",
        details: "Churn 8.2%, up from 5.1%",
        discussed: true,
      },
    });

    const out = await generateScreenInsight([frame()]);
    expect(generateObject).toHaveBeenCalledOnce();

    const call = generateObject.mock.calls[0][0];
    const parts = call.messages[0].content;
    // Must include an image part pointing at the frame URL...
    expect(parts).toContainEqual({
      type: "image",
      image: "https://store/frame.jpg",
    });
    // ...and a text part carrying the transcript excerpt.
    const text = parts.find((p: { type: string }) => p.type === "text").text;
    expect(text).toContain("olha esse número");

    expect(out?.captures).toHaveLength(1);
    expect(out?.captures[0].title).toBe("Q3 churn");
    expect(out?.captures[0].discussed).toBe(true);
    expect(out?.captures[0].atSeconds).toBe(120);
    expect(out?.captures[0].trigger).toBe("screen-start");
  });

  it("drops a frame whose vision call throws, keeps the rest", async () => {
    generateObject
      .mockRejectedValueOnce(new Error("unreadable image"))
      .mockResolvedValueOnce({
        object: {
          kind: "slide",
          title: "Roadmap",
          details: "Q4: launch",
          discussed: false,
        },
      });

    const out = await generateScreenInsight([
      frame({ atSeconds: 100 }),
      frame({ atSeconds: 200 }),
    ]);
    expect(out?.captures).toHaveLength(1);
    expect(out?.captures[0].title).toBe("Roadmap");
  });

  it("returns null when every frame fails to read", async () => {
    generateObject.mockRejectedValue(new Error("all bad"));
    const out = await generateScreenInsight([frame(), frame()]);
    expect(out).toBeNull();
  });

  it("ranks captures by screen-kind informativeness (dashboard first)", async () => {
    generateObject
      .mockResolvedValueOnce({
        object: { kind: "other", title: "misc", details: "", discussed: false },
      })
      .mockResolvedValueOnce({
        object: {
          kind: "dashboard",
          title: "metrics",
          details: "MRR 1.2M",
          discussed: true,
        },
      });

    const out = await generateScreenInsight([
      frame({ atSeconds: 50 }),
      frame({ atSeconds: 150 }),
    ]);
    expect(out?.captures[0].kind).toBe("dashboard");
    expect(out?.captures[1].kind).toBe("other");
  });
});
