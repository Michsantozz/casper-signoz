import { NextResponse, after } from "next/server";

/**
 * Bridge for Mastra's native agent channels (Slack ChatOps for the SRE-copilot).
 *
 * Mastra generates one webhook per `{agentId, platform}` at the canonical path
 * `/api/agents/{agentId}/channels/{platform}/webhook` and processes the event
 * through the normal agent pipeline (thread mapping → agent.stream → thread.post).
 * Next doesn't serve Mastra's routes itself, so this is the thin bridge: resolve
 * the AgentChannels for the agent and hand the raw Request to `handleWebhookEvent`.
 *
 * Signature verification (Slack HMAC + 5-min replay window) happens INSIDE the
 * adapter via SLACK_SIGNING_SECRET — we deliberately pass the raw Request through
 * untouched so the adapter reads the exact body it needs to verify. Streaming
 * work started during handling is kept alive past the response with `after()`
 * (the serverless `waitUntil` equivalent).
 *
 * No-op safety: if the agent has no adapter for that platform (Slack not wired,
 * SLACK_BOT_TOKEN unset), `getChannels()` has no entry / no adapter → 404. Slack
 * only points here once configured, so this is just a defensive guard.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ agentId: string; platform: string }> },
) {
  const { agentId, platform } = await params;

  const { mastra } = await import("@/mastra");
  const channels = mastra.getChannels()[agentId];
  if (!channels || !channels.hasAdapter(platform)) {
    return NextResponse.json(
      { error: "channel_not_configured", agentId, platform },
      { status: 404 },
    );
  }

  return channels.handleWebhookEvent(platform, req, {
    waitUntil: (task) => after(() => task),
  });
}
