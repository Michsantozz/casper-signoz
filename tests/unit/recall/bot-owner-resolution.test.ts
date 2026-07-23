import { describe, expect, it } from "vitest";
import { resolveBotOwner } from "@/server/recall/bot-repository";

const row = (userId: string) =>
  ({
    dedupKey: "dedup",
    botId: "bot",
    meetingUrl: "https://meet.example/test",
    joinAt: null,
    metadata: { user_id: userId },
    createdAt: new Date("2026-07-12T00:00:00Z"),
  }) satisfies NonNullable<Parameters<typeof resolveBotOwner>[0]>;

describe("resolveBotOwner", () => {
  it("uses the persisted mapping when metadata agrees or is absent", () => {
    expect(resolveBotOwner(row("owner"), "owner")).toEqual({
      userId: "owner",
      conflict: false,
    });
    expect(resolveBotOwner(row("owner"), null)).toEqual({
      userId: "owner",
      conflict: false,
    });
  });

  it("uses provider metadata only when no mapping exists", () => {
    expect(resolveBotOwner(null, "metadata-owner")).toEqual({
      userId: "metadata-owner",
      conflict: false,
    });
  });

  it("fails closed when the two tenant identities disagree", () => {
    expect(resolveBotOwner(row("persisted"), "supplied")).toEqual({
      userId: null,
      conflict: true,
      persistedUserId: "persisted",
      suppliedUserId: "supplied",
    });
  });
});
