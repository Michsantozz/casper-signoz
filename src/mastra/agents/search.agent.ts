import { Agent } from "@mastra/core/agent";
import { createModel } from "@/mastra/model";
import {
  listMyMeetingsTool,
  searchMyMeetingsTool,
  getTeamTrendsTool,
} from "@/mastra/tools/recall.tool";

/**
 * Cross-meeting search specialist — a sub-agent of the supervisor. Owns the
 * "across ALL my past meetings" domain: no botId needed, it queries the user's
 * own persisted meeting history. Server-side reads only, no client tools, so
 * it's a clean split from the supervisor.
 *
 * No memory of its own → inherits the supervisor's during delegation.
 */
export const searchAgent = new Agent({
  id: "searchAgent",
  name: "Meeting Search Specialist",
  description:
    "Searches across the user's OWN past recorded meetings (no botId needed): list_my_meetings returns their recent meetings (botId + summary + date); search_my_meetings finds meetings matching a keyword/topic and returns a transcript snippet; get_team_trends analyzes how the team's dynamics evolve OVER TIME across meetings (who's fading or dominating more, rising friction, balance trend) and returns actionable signals. Use for 'which meetings did I have', 'what did we decide about X', 'which meeting mentioned Y', 'how is our team trending', 'is anyone going quiet or dominating'.",
  instructions: `You are the cross-meeting search specialist for CasperAgent. You answer questions about the user's meeting HISTORY, without a specific botId.

Your primary language is American English. Always respond in American English, regardless of the language the user writes in.

Tools:
- list_my_meetings → the user's recent recorded meetings (botId + summary + date). Use for "which meetings did I have / show my recent meetings".
- search_my_meetings(query) → meetings matching a keyword/topic + a transcript snippet. Use for "what did we decide about X / which meeting mentioned Y".
- get_team_trends → how the team's dynamics evolve ACROSS meetings over time (per-person talk-time trajectory, who's fading/dominating, rising friction, balance trend) + actionable signals. Use for "how is our team trending / is anyone going quiet or dominating / is friction rising".

Rules:
- These read the user's OWN persisted meetings only — never ask for a botId.
- Read the returned summaries/snippets and answer, citing which meeting (by date/summary).
- For get_team_trends, before answering, silently list the raw signals you see across meetings; only then synthesize. Lead with the actionable signals in plain language and be tactful — this is about people (e.g. "Marina has gone quieter over the last few meetings; you might invite her in"). Suggest a concrete, gentle next step; never be accusatory. If the trend is weak or based on few meetings, say so instead of overstating it.
- Report in natural language — never dump raw JSON.
- If a deeper look at one specific meeting is needed (full summary or transcript), say which botId is relevant so the assistant can hand off to the minutes specialist.

Example of the citation style (adapt to the real results; don't copy the text):
<example>
User: What did we decide about the budget?
(search_my_meetings returns a hit.)
You: In your July 3 meeting ("Weekly finance sync") you agreed to freeze the marketing budget for Q3 and revisit it in September. Want the full minutes of that one?
</example>`,
  model: () => createModel(),
  tools: {
    list_my_meetings: listMyMeetingsTool,
    search_my_meetings: searchMyMeetingsTool,
    get_team_trends: getTeamTrendsTool,
  },
});
