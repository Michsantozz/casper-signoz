import { createSlackAdapter } from "@chat-adapter/slack";
import type { ChannelConfig } from "@mastra/core/channels";

/**
 * Slack channel for the SRE-copilot — ChatOps for the agent stack.
 *
 * Mentioning or DMing the bot in Slack (`@casper why did latency spike?`) routes
 * the message through Mastra's native channel pipeline into `sreAgent`, which
 * investigates via the SigNoz MCP tools and streams the answer back to the
 * thread. This is the same agent behind the in-app SRE-copilot and the
 * autonomous health-watch cron — Slack is just an additional surface, not a
 * second brain.
 *
 * Wiring: Mastra's `channels` config wraps the Chat SDK (@chat-adapter/slack)
 * and auto-generates the webhook route
 * `POST /api/agents/sreAgent/channels/slack/webhook` (served in the App Router
 * via _app/api-routes/agent-channels.ts). The adapter auto-detects
 * SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET from the environment.
 *
 * All-or-nothing, matching the SigNoz-MCP path (see mcp-signoz.ts): without
 * SLACK_BOT_TOKEN we register no adapter, so Mastra generates no route and the
 * feature is a safe no-op — the agent still works in-app and via cron.
 *
 * Streaming is on so the answer updates live in the thread, with typing status
 * surfaced through Slack's Assistant-mode indicator; `toolDisplay: 'text'`
 * renders the MCP tool calls inline rather than as approval cards (the SRE reads
 * telemetry — nothing here is a destructive tool that warrants an approval gate).
 */
const slackBotToken = process.env.SLACK_BOT_TOKEN;

/** True when the Slack channel is configured (bot token present). */
export const slackChannelEnabled = Boolean(slackBotToken);

/**
 * The `channels` config to spread onto `sreAgent`, or `undefined` when Slack is
 * not wired — so the agent definition stays a plain `channels?:` pass-through.
 */
export const slackChannels: ChannelConfig | undefined = slackBotToken
  ? {
      userName: "casper",
      adapters: {
        slack: {
          adapter: createSlackAdapter(),
          streaming: true,
          toolDisplay: "text",
        },
      },
    }
  : undefined;
