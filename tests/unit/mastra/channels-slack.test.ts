import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Slack channel config (mastra/channels-slack.ts) for the sreAgent.
 *
 * Same graceful-degradation contract as the SigNoz MCP client: without
 * SLACK_BOT_TOKEN we register NO adapter, so `slackChannels` is `undefined` and
 * `slackChannelEnabled` is false — Mastra generates no webhook route and the
 * ChatOps surface is a safe no-op. When the token IS set, `slackChannels` is a
 * ChannelConfig with exactly one streaming Slack adapter and text tool-display.
 *
 * We mock @chat-adapter/slack's createSlackAdapter so no real Slack client is
 * built. The env is read at MODULE LOAD, so each case sets env then
 * dynamic-imports under resetModules.
 */

const ORIGINAL_ENV = { ...process.env };
const createSlackAdapter = vi.fn((_config?: unknown) => ({ __adapter: "slack" }));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: (config?: unknown) => createSlackAdapter(config),
}));

beforeEach(() => {
  vi.resetModules();
  createSlackAdapter.mockClear();
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_SIGNING_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("slackChannels — gating", () => {
  it("is undefined and disabled when SLACK_BOT_TOKEN is unset (graceful no-op)", async () => {
    const { slackChannels, slackChannelEnabled } = await import(
      "@/mastra/channels-slack"
    );
    expect(slackChannels).toBeUndefined();
    expect(slackChannelEnabled).toBe(false);
    // No adapter is even constructed when Slack is unwired.
    expect(createSlackAdapter).not.toHaveBeenCalled();
  });

  it("builds a streaming Slack channel config when the token is set", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const { slackChannels, slackChannelEnabled } = await import(
      "@/mastra/channels-slack"
    );

    expect(slackChannelEnabled).toBe(true);
    expect(createSlackAdapter).toHaveBeenCalledTimes(1);
    expect(slackChannels).toBeDefined();

    const slack = slackChannels!.adapters.slack as {
      adapter: unknown;
      streaming: boolean;
      toolDisplay: string;
    };
    expect(slack.adapter).toEqual({ __adapter: "slack" });
    // Streaming on → the answer updates live in the thread.
    expect(slack.streaming).toBe(true);
    // Read-only telemetry tools → inline text, not approval cards.
    expect(slack.toolDisplay).toBe("text");
    // A single bot identity across the workspace.
    expect(Object.keys(slackChannels!.adapters)).toEqual(["slack"]);
  });

  it("token alone enables it — signing secret is optional at config time", async () => {
    // The adapter verifies signatures with SLACK_SIGNING_SECRET at request
    // time; its presence does not gate config construction.
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const { slackChannelEnabled } = await import("@/mastra/channels-slack");
    expect(slackChannelEnabled).toBe(true);
  });
});
