import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse, jsonSchema, stepCountIs, tool } from "ai";
import type { JSONSchema7 } from "ai";
import { NextResponse, after } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { isBotOwner } from "@/server/recall/ownership";
import { checkRateLimit, rateLimitedResponse } from "@/shared/lib/rate-limit";
import { assertBodyWithinLimit } from "@/shared/lib/http";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("chat");

// Pre-parse ceiling on the chat body. Generous for a real turn (messages +
// client tool JSON schemas + threadId) but hostile to a payload crafted to
// exhaust memory before req.json() even returns. See audit fix #5.
const MAX_CHAT_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

/** A v6 UIMessage as it arrives from the transport (only what we read/build). */
type UIMessageLike = {
  role: string;
  parts?: Array<{ type: string; text?: string }>;
};

/**
 * Builds the text that pins the agent to the meeting the user has open, so
 * "summarize this", "who spoke most?", "what were the objections?" resolve to
 * `botId` without the user restating it.
 *
 * Passed to the handler via the dedicated `system` param (a plain string) —
 * NOT prepended to `messages`. `messages` carries UIMessages (role+parts); a
 * system entry shaped as a UIMessage (`parts:[…]`) fails Mastra's
 * CoreMessage conversion ("System messages must be CoreMessage format with
 * 'role' and 'content'") and 500s the whole turn. `system` is the canonical
 * per-request system prompt slot and appends to the agent's own instructions.
 */
function meetingContextInstruction(botId: string): string {
  return (
    `The user is currently viewing the notebook for meeting botId="${botId}". ` +
    `When they refer to "this meeting", "this call", or ask about it without ` +
    `naming another, use this botId with the by-bot tools (get_transcript, ` +
    `summarize_meeting, get_participants, get_recording). Do not ask which ` +
    `meeting they mean.`
  );
}

// Shape of what AssistantChatTransport injects into the body (assistant-ui):
// tools: Record<name, { description?, parameters: JSONSchema7 }>.
type FrontendToolJSONSchema = {
  description?: string;
  parameters: JSONSchema7;
};

/**
 * Converts the tools sent by the frontend (assistant-ui frontend tools) into
 * Mastra clientTools. These are tools WITHOUT server-side `execute`: the agent
 * exposes them to the model, the model calls them, and execution happens in
 * the browser (the UI fulfills the tool-call and returns the result). This is
 * how `pick_date` / `connect_calendar` run their UI flow on the client.
 */
function toClientTools(
  tools: Record<string, FrontendToolJSONSchema> | undefined,
) {
  if (!tools) return undefined;
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters),
        // no `execute`: the client fulfills the call.
      }),
    ]),
  );
}

export async function POST(req: Request) {
  // Auth gate: chat consumes LLM (cost) and grants access to meeting tools.
  // Without a session, we don't serve — blocks quota abuse/DoS before any work.
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Per-user rate limit: each turn hits the LLM (real $ on Bedrock/Fireworks).
  // Auth alone doesn't bound cost — a logged-in user could loop the endpoint and
  // burn the budget. 20 requests / 60s is generous for a human, hostile to a script.
  const rl = await checkRateLimit({
    key: `chat:${session.user.id}`,
    window: 60,
    max: 20,
  });
  if (!rl.ok) return rateLimitedResponse(rl.retryAfter);

  // Reject an oversized body by declared Content-Length BEFORE parsing it into
  // memory (audit fix #5).
  const tooLarge = assertBodyWithinLimit(req, MAX_CHAT_BODY_BYTES);
  if (tooLarge) return tooLarge;

  const params = await req.json();
  // The transport injects `tools` (JSON Schema) and — for multi-thread chat —
  // a `threadId` (the active sidebar thread). `meetingBotId` is sent by the
  // notebook so the agent knows which meeting is open. `agentId` selects which
  // agent handles the turn (see allowlist below). We forward tools as
  // clientTools and bind memory to that thread so Mastra persists/recalls per
  // conversation. The rest of `params` passes through unchanged to the handler.
  const {
    tools,
    threadId,
    meetingBotId,
    agentId: requestedAgentId,
    messages,
    ...rest
  } = params as {
    tools?: Record<string, FrontendToolJSONSchema>;
    threadId?: string;
    meetingBotId?: string;
    agentId?: string;
    messages?: UIMessageLike[];
  } & Record<string, unknown>;

  // Agent selection is an ALLOWLIST, never the raw body value: a caller could
  // otherwise name any registered agent (e.g. a sub-agent) or an unknown id.
  // `assistantAgent` is the default (home chat = the supervisor); the meeting
  // notebook asks for `minutesAgent` (the meeting specialist, talked to
  // directly). Anything else falls back to the supervisor.
  const AGENT_ALLOWLIST = ["assistantAgent", "minutesAgent"] as const;
  const agentId = AGENT_ALLOWLIST.includes(
    requestedAgentId as (typeof AGENT_ALLOWLIST)[number],
  )
    ? (requestedAgentId as (typeof AGENT_ALLOWLIST)[number])
    : "assistantAgent";

  // Meeting context: only inject if the caller actually OWNS the bot. An
  // unowned/forged meetingBotId is silently ignored — never surfaced to the
  // agent — so this can't be used to point the agent at another tenant's bot.
  // (The by-bot tools re-check ownership anyway; this is defense in depth.)
  // Delivered via the `system` param below (a plain string appended to the
  // agent's instructions), NOT as a message in `messages` — a system entry
  // shaped as a UIMessage fails Mastra's CoreMessage conversion and 500s.
  const meetingContext =
    meetingBotId && (await isBotOwner(meetingBotId, session.user.id))
      ? meetingContextInstruction(meetingBotId)
      : undefined;

  const { mastra } = await import("@/mastra");

  // Serialize the store's one-time schema init before the agent touches memory —
  // otherwise a cold store hit by this turn concurrently with the notebook's
  // thread init/history load collides on RoutingDbClient's pinned connection.
  // ensureMastraVectorIndex pre-creates the 1024-dim embedding index as HNSW
  // BEFORE Memory would auto-create it as ivfflat (which fails past 2000 dims and
  // loops the whole turn) — see src/mastra/storage.ts.
  const { ensureMastraStoreInit, ensureMastraVectorIndex, ensureMastraResource } =
    await import("@/mastra/storage");
  await Promise.all([ensureMastraStoreInit(), ensureMastraVectorIndex()]);

  // Memory binding: `resource` is ALWAYS the session user id (never trusted
  // from the body — that would let a caller read another user's thread), and
  // `thread` is the active sidebar thread. Without a threadId (e.g. a brand-new
  // conversation before the sidebar assigns one), we omit memory and let the
  // handler run stateless for that turn.
  const memory = threadId
    ? { memory: { thread: threadId, resource: session.user.id } }
    : {};

  // Pre-create the user's working-memory resource row so Mastra's own resource
  // write is a safe UPDATE, never a racing INSERT that violates the PK and loops
  // the turn (see ensureMastraResource). Only when memory is active for this turn.
  if (threadId) await ensureMastraResource(session.user.id);

  // version:'v6' required — assistant-ui types against AI SDK v6.
  const stream = await handleChatStream({
    mastra,
    agentId,
    params: {
      ...rest,
      messages,
      // Per-turn step ceiling: bound the SERVER-side tool loop (one model call +
      // its tool round-trip per step) so a runaway agent can't spin unbounded on
      // the server. This is defence-in-depth, NOT the fix for the client resend
      // loop — that lives in shouldResumeAfterClientTool (resume-predicate.ts).
      // Set on the request; the constructor AgentConfig doesn't accept it in this
      // Mastra version (it's a stream/generate option via AgentExecutionOptions).
      stopWhen: stepCountIs(5),
      // Per-request system prompt (meeting pin). Appends to the agent's own
      // instructions; omitted when there's no owned meeting in context.
      ...(meetingContext ? { system: meetingContext } : {}),
      ...memory,
      clientTools: toClientTools(tools),
      // Persist the turn to memory incrementally (per step) instead of only
      // once the whole stream is consumed. This is what makes the detached
      // drain below actually recoverable: if the user navigates away and the
      // client aborts, whatever the agent produced up to the last completed
      // step is already saved to the thread — nothing needs the final chunk to
      // be flushed. No-op without memory (stateless turn / no threadId).
      ...(threadId ? { savePerStep: true } : {}),
    } as Parameters<typeof handleChatStream>[0]["params"],
    version: "v6",
    // handleChatStream masks stream errors by default (start→finish, no text).
    // Surface the real cause into the stream so a model/provider/processor
    // failure is diagnosable. Server-side we log ONLY the error message — never
    // the full error object, which can carry request/response bodies (user +
    // model content = PII) from the provider SDK.
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Log ONLY the message — never the error object (provider SDK may attach
      // request/response bodies = user + model content = PII).
      log.error({ message }, "stream error");
      return message;
    },
  } as Parameters<typeof handleChatStream>[0]);

  // Detached generation: the UIMessage stream is lazy — it only advances while
  // something pulls from it. When the user leaves the page / switches tabs, the
  // client aborts the fetch and Next closes the response, so the branch wired to
  // the HTTP body stops being pulled and generation would freeze mid-turn (the
  // reported bug: the answer never lands). We tee() the stream: one branch feeds
  // the client as before; the other is drained server-side to completion,
  // independent of the client. That keeps the agent loop running to the end so
  // its steps get persisted (savePerStep above) — on return, the thread history
  // refetch shows the full answer. `after()` runs the drain after the response
  // is sent and, on our long-lived Node server (output:'standalone', nodejs
  // runtime), keeps the work alive past the client disconnect. This does NOT
  // resume the live token stream on return (that needs a resumable-stream store,
  // e.g. Redis) — it guarantees the turn completes and is saved.
  const [clientBranch, serverBranch] = stream.tee();

  // Drain via getReader() (spec base, no reliance on Symbol.asyncIterator which
  // isn't guaranteed on every runtime's ReadableStream). We don't need the
  // chunks, just the pull that keeps the agent loop — and its per-step saves —
  // progressing to the end.
  const drain = async () => {
    const reader = serverBranch.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ message }, "detached drain error");
    } finally {
      reader.releaseLock();
    }
  };

  // Prefer `after()`: it keeps the drain alive past the response on the
  // long-lived Node server (output:'standalone', nodejs runtime). `after` throws
  // "outside a request scope" when there's no Next request context (unit tests
  // calling POST directly) — fall back to a detached fire-and-forget so the
  // route still works. The tee'd server branch is never left unread either way.
  try {
    after(drain);
  } catch {
    void drain();
  }

  return createUIMessageStreamResponse({ stream: clientBranch });
}
