import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { createModel, createEmbedder } from "@/mastra/model";
import { getMastraStore, getMastraVector } from "@/mastra/storage";
import {
  getRecallTranscriptTool,
  getRecallRecordingTool,
  summarizeRecallMeetingTool,
  getRecallParticipantsTool,
  getMeetingDynamicsTool,
} from "@/mastra/tools/recall.tool";

/**
 * Minutes specialist — a sub-agent of the supervisor (assistantAgent). Owns the
 * "after a meeting" domain: turning a recorded meeting into minutes. It has NO
 * client tools (pick_date/connect_calendar don't reach sub-agents — clientTools
 * are request-scoped to the agent the route invokes), which is exactly why this
 * domain is a clean split: it's all server-side by-botId reads.
 *
 * The supervisor delegates here via its `agents` field; `description` is what
 * the auto-generated delegation tool advertises to the supervisor's model.
 *
 * TWO entry points, hence its OWN memory:
 *  - As a sub-agent (supervisor delegation): the supervisor passes it the botId
 *    and the delegated task; the delegation is one-shot, so memory is moot there.
 *  - DIRECTLY, as the meeting notebook's agent: the notebook calls /api/chat with
 *    agentId="minutesAgent", a per-meeting threadId, and the botId pinned via a
 *    system message. Here the conversation IS persisted — so this agent needs its
 *    own Memory (same PG schema `mastra`, resourceId-scoped to the user). Without
 *    it, `agent.stream({ memory: { thread, resource } })` would have nowhere to
 *    persist/recall the notebook conversation.
 */
export const minutesAgent = new Agent({
  id: "minutesAgent",
  name: "Minutes Specialist",
  description:
    "Turns a recorded meeting into minutes: summary, decisions, action items, topics (summarize_meeting), participants and speaking time (get_participants), the raw transcript (get_transcript), the recorded media (get_recording), and team-dynamics / meeting-health metrics — who dominated, interruptions, silences, monologues, balance (get_meeting_dynamics). Use for any 'what happened' or 'how did the team interact' request once a botId is known.",
  instructions: `You are the minutes specialist for CasperAgent. Given a meeting (by botId), you produce clear, actionable minutes.

Your primary language is American English. Always respond in American English, regardless of the language the user writes in.

Tools:
- summarize_meeting → summary + decisions + action items + topics.
- get_participants → list of names + speaking time.
- get_transcript → the raw transcript.
- get_recording → the recorded media, once processing finishes.
- get_meeting_dynamics → team-dynamics / meeting-health metrics: talk-time share per person, interruptions (who cut off whom), silences, monologues, turn-taking, and an overall participation balance (0..1). Use for "how did the team interact", "who dominated", "was it balanced", "any tension" questions.

Rules:
- You always receive the botId in the delegated task. Never ask the user for it.
- Report results in natural language — never dump raw JSON.
- If the recording/transcript isn't ready yet, say so plainly and suggest trying again shortly.

Tone for get_meeting_dynamics (sensitive):
- These metrics describe real, named people (who dominated, who was interrupted, who went quiet). Be tactful and descriptive, never accusatory or judgmental. Frame it as an observation plus a constructive next step, not a verdict on someone's character. If the signal is thin or ambiguous, say so rather than overstating it.

Example of the output shape and tone (adapt to the actual meeting; don't copy the text):
<example>
Delegated task: summarize meeting (botId known).
You call summarize_meeting, then present:

**Summary** — The team reviewed Q3 pricing and agreed to ship the new tiers in August.

**Decisions**
- Move enterprise pricing up 12%, effective Aug 1.
- Keep the free tier unchanged for now.

**Action items**
- Ana: draft the customer email (by Fri).
- Joe: update the pricing page.

**Topics** — pricing tiers, churn risk, rollout timeline.
</example>`,
  model: () => createModel(),
  // Own persistent memory in PG (schema `mastra`) — used when the notebook talks
  // to this agent DIRECTLY (one thread per meeting, resourceId-scoped to the
  // user). Lazy for the same reason as the supervisor's: createEmbedder() reads
  // FIREWORKS_API_KEY via requireEnv (throws if absent), so building it per
  // request keeps `next build` working env-free.
  //  - generateTitle: names the meeting thread from the first user message and
  //    persists it via updateThread (async, doesn't slow the response).
  //  - semanticRecall (resource-scoped): notebook turns are embedded (Fireworks
  //    Qwen3-Embedding-8B) into pgvector and retrieved by meaning, so a long
  //    back-and-forth about one meeting can pull the relevant earlier turn back.
  //  - No workingMemory: the notebook is scoped to ONE meeting, not a durable
  //    per-user profile (that lives on the supervisor).
  memory: () =>
    new Memory({
      storage: getMastraStore(),
      vector: getMastraVector(),
      embedder: createEmbedder(),
      options: {
        lastMessages: 20,
        generateTitle: true,
        semanticRecall: {
          topK: 5,
          messageRange: 2,
          scope: "resource",
        },
      },
    }),
  tools: {
    summarize_meeting: summarizeRecallMeetingTool,
    get_participants: getRecallParticipantsTool,
    get_transcript: getRecallTranscriptTool,
    get_recording: getRecallRecordingTool,
    get_meeting_dynamics: getMeetingDynamicsTool,
  },
});
