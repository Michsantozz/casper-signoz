import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recallFetch, RecallAdhocPoolError } from "@/server/recall/client";
import {
  getOrCreateBotMapping,
  deleteBotMapping,
  defaultDedupKey,
} from "@/server/recall/bot-repository";
import { summarizeMeeting } from "@/server/recall/summarize";
import {
  listMeetingRecordsForUser,
  searchMeetingRecords,
  findMeetingRecord,
  listDynamicsForUser,
} from "@/server/recall/meeting-repository";
import { computeTeamTrends } from "@/server/recall/dynamics-trends";
import { pickRecording, wrapUntrustedTranscript } from "@/server/recall/recordings";
import { assertBotOwner, isBotOwner } from "@/server/recall/ownership";
import { withUserScope } from "@/shared/db/rls";
import { getSession } from "@/features/auth/model/session";

/**
 * Resolves the caller's session userId and asserts they own `botId`, or throws.
 * Every tool that reads a meeting by a raw botId (transcript/recording/
 * participants/summary/state) MUST call this before touching Recall — RLS does
 * not cover these direct Recall reads. Fail-closed: no session → throws.
 */
async function requireBotOwner(botId: string): Promise<string> {
  const userId = (await getSession())?.user?.id;
  if (!userId) {
    throw new Error("Not authenticated — cannot access meeting data.");
  }
  await assertBotOwner(botId, userId);
  return userId;
}

/**
 * "Front-desk" tools for Recall.ai bots — writes via REST.
 *
 * Rich reads (recordings, transcript, calendar) already come from the
 * recall-ai MCP tools (read-only). These tools cover what the MCP does NOT
 * do: creating, scheduling, controlling, and removing bots, with
 * deduplication in the app's DB.
 *
 * Receipt convention: the tools return { ok, botId, ... } — they don't dump
 * the entire recording/transcript into the result (capability boundary).
 */

/** Recording media artifact (transcript/audio/video). */
type MediaArtifact = {
  id?: string;
  status?: { code?: string };
  data?: { download_url?: string };
} | null;

/** participant_events artifact: exposes download URLs for participants/timeline. */
type ParticipantEventsArtifact = {
  status?: { code?: string };
  data?: {
    participants_download_url?: string;
    speaker_timeline_download_url?: string;
    participant_events_download_url?: string;
  };
} | null;

type RecallRecording = {
  id: string;
  status?: { code?: string };
  media_shortcuts?: {
    transcript?: MediaArtifact;
    video_mixed?: MediaArtifact;
    audio_mixed?: MediaArtifact;
    participant_events?: ParticipantEventsArtifact;
  };
};

/** Partial shape of the Recall bot (only what we consume in the receipt). */
type RecallBot = {
  id: string;
  status_changes?: Array<{ code?: string; created_at?: string }>;
  join_at?: string | null;
  meeting_url?: unknown;
  recordings?: RecallRecording[];
};

function latestStatus(bot: RecallBot): string | undefined {
  const changes = bot.status_changes;
  return changes?.[changes.length - 1]?.code;
}

/** Raw transcript segment: participant + words with timestamps. */
type TranscriptSegment = {
  participant?: { name?: string | null };
  words?: Array<{
    text?: string;
    start_timestamp?: { relative?: number } | null;
    end_timestamp?: { relative?: number } | null;
  }>;
};

/**
 * Downloads and parses a bot's transcript.
 *
 * Returns the transcript state and (if ready) the raw segments. Shared by
 * get_transcript (human-readable text) and summarize_meeting (LLM input).
 */
async function loadTranscript(botId: string): Promise<{
  bot: RecallBot;
  state: "ready" | "processing" | "none";
  segments: TranscriptSegment[];
}> {
  const bot = await recallFetch<RecallBot>({
    method: "GET",
    path: `v1/bot/${botId}/`,
  });

  // A bot can have >1 recording (re-join/resume); pickRecording reads the
  // transcript-`done` one instead of `[0]` blindly (see recordings.ts).
  const transcript = pickRecording(bot.recordings, botId)?.media_shortcuts
    ?.transcript;
  if (!transcript) return { bot, state: "none", segments: [] };

  const url = transcript.data?.download_url;
  if (transcript.status?.code !== "done" || !url) {
    return { bot, state: "processing", segments: [] };
  }

  const res = await fetch(url);
  const segments = (await res.json()) as TranscriptSegment[];
  return { bot, state: "ready", segments };
}

/** Builds "participant: speech" text + set of speakers from the segments. */
function renderTranscript(segments: TranscriptSegment[]): {
  text: string;
  speakers: string[];
} {
  const speakers = new Set<string>();
  const lines = segments.map((seg) => {
    const who = seg.participant?.name ?? "Unknown";
    speakers.add(who);
    const text = (seg.words ?? []).map((w) => w.text ?? "").join(" ").trim();
    return `${who}: ${text}`;
  });
  return { text: lines.join("\n"), speakers: [...speakers] };
}

/**
 * Schedules (or reuses) a bot to join a meeting.
 *
 * - join_at > 10 min in the future → scheduled (guaranteed join).
 * - join_at omitted / <= 10 min → ad-hoc (can fail with 507; retry ~30s).
 * Deduplicates by dedup_key: if a bot already exists for the meeting, reuses it instead of creating one.
 */
export const scheduleRecallBotTool = createTool({
  id: "schedule_recall_bot",
  description:
    "Schedules or starts a Recall.ai bot to join a meeting by its raw meeting URL (Zoom/Meet/Teams/etc.). " +
    "Pass join_at (ISO 8601, >10min in the future) to schedule with a guaranteed join, or omit it to join now (ad-hoc). " +
    "Deduplicates automatically: doesn't create a duplicate bot for the same meeting. " +
    "Use this when you only have a meeting link or a custom time; if the meeting is already a connected-calendar event, prefer schedule_bot_for_event instead.",
  inputSchema: z.object({
    meetingUrl: z.url().describe("Meeting URL"),
    joinAt: z.iso
      .datetime()
      .optional()
      .describe("Join time in ISO 8601. Omit to join now (ad-hoc)."),
    botName: z
      .string()
      .optional()
      .describe('Name shown in the call. Recall default: "Meeting Notetaker".'),
    dedupKey: z
      .string()
      .optional()
      .describe("Custom dedup key. Default: derived from joinAt+meetingUrl."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    botId: z.string(),
    reused: z.boolean().describe("true if an existing bot was reused"),
    scheduled: z.boolean().describe("true=scheduled, false=ad-hoc"),
    dedupKey: z.string(),
  }),
  execute: async (input) => {
    // Meeting owner = session user (never comes from chat). Resolved BEFORE the
    // dedup key so the key is namespaced per tenant — two users scheduling the
    // same meeting must not collide on one bot. Persisted in the bot's metadata
    // so the webhook/enrich know who to notify.
    const session = await getSession();
    const userId = session?.user?.id ?? null;
    if (!userId) {
      // No owner → the bot would be an orphan (hidden by RLS, no one to notify).
      // Refuse instead of scheduling a bot no one can ever see.
      throw new Error("Cannot schedule a bot without an authenticated user.");
    }

    const dedupKey =
      input.dedupKey ?? defaultDedupKey(userId, input.meetingUrl, input.joinAt);

    let result: Awaited<ReturnType<typeof getOrCreateBotMapping>>;
    try {
      result = await getOrCreateBotMapping({
        dedupKey,
        meetingUrl: input.meetingUrl,
        joinAt: input.joinAt ? new Date(input.joinAt) : null,
        metadata: { user_id: userId },
        createBot: () =>
          recallFetch<RecallBot>({
            method: "POST",
            path: "v1/bot/",
            body: {
              meeting_url: input.meetingUrl,
              ...(input.joinAt ? { join_at: input.joinAt } : {}),
              ...(input.botName ? { bot_name: input.botName } : {}),
              recording_config: {
                transcript: { provider: { recallai_streaming: {} } },
                participant_events: {},
                start_recording_on: "participant_join",
              },
              metadata: { dedup_key: dedupKey, user_id: userId },
            },
          }),
      });
    } catch (err) {
      if (err instanceof RecallAdhocPoolError) {
        throw new Error(
          "Ad-hoc bot pool exhausted (507). Try again in ~30s, or schedule with join_at >10min in the future.",
        );
      }
      throw err;
    }

    return {
      ok: true,
      botId: result.row.botId,
      reused: !result.created,
      scheduled: result.row.joinAt != null,
      dedupKey,
    };
  },
});

/** Checks a bot's current state. */
export const getRecallBotTool = createTool({
  id: "get_recall_bot",
  description:
    "Checks the current state of a Recall.ai bot (joining, in_call_recording, done, fatal, etc.) by its ID.",
  inputSchema: z.object({
    botId: z.string().describe("Bot UUID"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    status: z.string().optional(),
    joinAt: z.string().nullable().optional(),
  }),
  execute: async (input) => {
    await requireBotOwner(input.botId);
    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });
    return {
      botId: bot.id,
      status: latestStatus(bot),
      joinAt: bot.join_at ?? null,
    };
  },
});

/**
 * Reads a bot's transcript after the meeting.
 *
 * The transcript lives in recordings[].media_shortcuts.transcript. When
 * ready (`status=done`), it has a `download_url` for a JSON with the
 * speech — we download it and build a human-readable text (participant:
 * speech). If still processing or if the bot didn't record with a
 * transcript, returns the corresponding state.
 */
export const getRecallTranscriptTool = createTool({
  id: "get_recall_transcript",
  description:
    "Reads the transcript of a meeting recorded by a Recall.ai bot, by botId. " +
    "Returns the conversation text (per participant) if already ready. " +
    "Use after the meeting ends and the recording finishes processing.",
  inputSchema: z.object({
    botId: z.string().describe("UUID of the bot that recorded the meeting"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    transcript: z.string().nullable(),
    speakers: z.array(z.string()).optional(),
  }),
  execute: async (input) => {
    const userId = await requireBotOwner(input.botId);

    // Local-first: our persisted minutes survive Recall's artifact expiry, so a
    // transcript from an old meeting is still answerable long after Recall drops
    // the raw recording. Only fall back to Recall when we haven't saved it yet
    // (e.g. a meeting that just ended and hasn't been processed).
    const record = await withUserScope(userId, () =>
      findMeetingRecord(input.botId),
    );
    if (record?.transcript) {
      const speakers = record.transcriptStruct
        ? [...new Set(record.transcriptStruct.map((s) => s.speaker))]
        : undefined;
      return {
        botId: input.botId,
        state: "ready" as const,
        // Transcript is attacker-reachable speech re-entering the privileged
        // supervisor context — frame it as data, not instructions (SEC).
        transcript: wrapUntrustedTranscript(record.transcript),
        speakers,
      };
    }

    const { bot, state, segments } = await loadTranscript(input.botId);
    if (state !== "ready") {
      return { botId: bot.id, state, transcript: null };
    }
    const { text, speakers } = renderTranscript(segments);
    return {
      botId: bot.id,
      state,
      transcript: wrapUntrustedTranscript(text),
      speakers,
    };
  },
});

/** Lists a bot's recorded media (video/audio/transcript) and their states. */
export const getRecallRecordingTool = createTool({
  id: "get_recall_recording",
  description:
    "Lists a Recall.ai bot's recorded media (video, audio, transcript) and the state of each, with a download link when ready. " +
    "Returns only metadata and download links — NOT the transcript text itself. To read the actual conversation text, use get_recall_transcript.",
  inputSchema: z.object({
    botId: z.string().describe("Bot UUID"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    recordingStatus: z.string().nullable(),
    media: z.array(
      z.object({
        kind: z.string(),
        status: z.string().nullable(),
        downloadUrl: z.string().nullable(),
      }),
    ),
  }),
  execute: async (input) => {
    await requireBotOwner(input.botId);
    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });
    // A bot can have >1 recording (re-join/resume); pickRecording reads the
    // transcript-ready one instead of blindly taking recordings[0].
    const rec = pickRecording(bot.recordings, input.botId);
    const ms = rec?.media_shortcuts ?? {};

    const media = (["video_mixed", "audio_mixed", "transcript"] as const).map(
      (kind) => {
        const a = ms[kind];
        return {
          kind,
          status: a?.status?.code ?? null,
          downloadUrl: a?.data?.download_url ?? null,
        };
      },
    );

    return {
      botId: bot.id,
      recordingStatus: rec?.status?.code ?? null,
      media,
    };
  },
});

/**
 * Post-meeting summary: takes the transcript and generates a summary + decisions + tasks.
 *
 * Reads the bot's transcript (same source as get_transcript), passes it to
 * the LLM via generateObject and returns a structure: summary, decisions,
 * action items (with owner when mentioned), topics. If the transcript isn't
 * ready, returns the corresponding state without calling the LLM.
 */
export const summarizeRecallMeetingTool = createTool({
  id: "summarize_recall_meeting",
  description:
    "Generates a meeting summary from the transcript of a Recall.ai bot (by botId): " +
    "executive summary, decisions made, action items (tasks with an owner when mentioned), and topics. " +
    "Use after the meeting ends and the transcript is ready.",
  inputSchema: z.object({
    botId: z.string().describe("UUID of the bot that recorded the meeting"),
    focus: z
      .string()
      .optional()
      .describe('Optional summary focus, e.g. "product decisions", "next steps".'),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    summary: z.string().nullable(),
    decisions: z.array(z.string()).optional(),
    actionItems: z
      .array(z.object({ task: z.string(), owner: z.string().nullable() }))
      .optional(),
    topics: z.array(z.string()).optional(),
  }),
  // Delegates to the reusable server function (same logic used by the bot
  // webhook that generates the automatic minutes at the end of the meeting).
  execute: async (input) => {
    await requireBotOwner(input.botId);
    return summarizeMeeting(input.botId, input.focus);
  },
});

/**
 * Lists participants and calculates meeting speaking time.
 *
 * Attendance comes from the participant_events artifact (participants_download_url).
 * Speaking time is derived from the transcript itself (sum of word
 * durations per participant via timestamps), avoiding a dependency on a
 * second artifact.
 */
export const getRecallParticipantsTool = createTool({
  id: "get_recall_participants",
  description:
    "Lists the participants of a meeting recorded by a Recall.ai bot (by botId) and each person's speaking time. " +
    "Use after the meeting to see who attended and who talked the most.",
  inputSchema: z.object({
    botId: z.string().describe("UUID of the bot that recorded the meeting"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    state: z.enum(["ready", "processing", "none"]),
    participants: z
      .array(
        z.object({
          name: z.string(),
          isHost: z.boolean().nullable(),
          speakingSeconds: z.number(),
        }),
      )
      .optional(),
  }),
  execute: async (input) => {
    const userId = await requireBotOwner(input.botId);

    // Local-first: talkShares (name + speaking %) persist with the minutes, so
    // an old meeting still lists who attended long after Recall expires the
    // participant artifact. Speaking seconds are derived from the saved
    // word-level transcript's span; if unavailable, we report the % share only.
    const record = await withUserScope(userId, () =>
      findMeetingRecord(input.botId),
    );
    if (record?.talkShares?.length) {
      const struct = record.transcriptStruct ?? [];
      let totalSeconds = 0;
      for (const utt of struct) {
        const last = utt.words[utt.words.length - 1]?.end;
        if (last != null && last > totalSeconds) totalSeconds = last;
      }
      const participants = record.talkShares
        .map((t) => ({
          name: t.name,
          isHost: null,
          speakingSeconds: Math.round((t.share ?? 0) * totalSeconds),
        }))
        .sort((a, b) => b.speakingSeconds - a.speakingSeconds);
      return { botId: input.botId, state: "ready" as const, participants };
    }

    const bot = await recallFetch<RecallBot>({
      method: "GET",
      path: `v1/bot/${input.botId}/`,
    });

    // A bot can have >1 recording (re-join/resume); read the transcript-ready
    // one via pickRecording instead of blindly taking recordings[0].
    const rec = pickRecording(bot.recordings, input.botId);
    const pe = rec?.media_shortcuts?.participant_events;
    const peUrl = pe?.data?.participants_download_url;
    if (!pe || pe.status?.code !== "done" || !peUrl) {
      return { botId: bot.id, state: "processing" as const };
    }

    // Attendance: list of participants from the artifact.
    const peRes = await fetch(peUrl);
    const rawParticipants = (await peRes.json()) as Array<{
      name?: string | null;
      is_host?: boolean | null;
    }>;

    // Speaking time derived from the transcript (word duration per name).
    const speaking = new Map<string, number>();
    const transcript = rec?.media_shortcuts?.transcript;
    if (transcript?.status?.code === "done" && transcript.data?.download_url) {
      const tRes = await fetch(transcript.data.download_url);
      const segments = (await tRes.json()) as TranscriptSegment[];
      for (const seg of segments) {
        const who = seg.participant?.name ?? "Unknown";
        const words = seg.words ?? [];
        const start = words[0]?.start_timestamp?.relative;
        const end = words[words.length - 1]?.end_timestamp?.relative;
        const dur =
          start != null && end != null && end >= start ? end - start : 0;
        speaking.set(who, (speaking.get(who) ?? 0) + dur);
      }
    }

    // Dedup by name (re-joins create duplicates) and merges with speaking time.
    const byName = new Map<string, { isHost: boolean | null }>();
    for (const p of rawParticipants) {
      const name = p.name ?? "Unknown";
      if (!byName.has(name)) byName.set(name, { isHost: p.is_host ?? null });
    }
    // Ensures anyone who spoke but didn't appear in the list is included (rare).
    for (const name of speaking.keys()) {
      if (!byName.has(name)) byName.set(name, { isHost: null });
    }

    const participants = [...byName.entries()]
      .map(([name, v]) => ({
        name,
        isHost: v.isHost,
        speakingSeconds: Math.round(speaking.get(name) ?? 0),
      }))
      .sort((a, b) => b.speakingSeconds - a.speakingSeconds);

    return { botId: bot.id, state: "ready" as const, participants };
  },
});

/** Lists bots scheduled for the future. */
/**
 * Cross-meeting index: lists the caller's PAST meetings (persisted minutes),
 * most recent first. Gives the agent the botIds + summaries so it can answer
 * "which meetings did I have?" / "the meeting yesterday about X" and then drill
 * in with summarize_meeting / get_transcript. Reads meeting_records (not Recall,
 * whose artifacts expire), scoped to the session user via RLS.
 */
export const listMyMeetingsTool = createTool({
  id: "list_my_meetings",
  description:
    "Lists the current user's PAST recorded meetings (with generated minutes), most recent first. " +
    "Use to see which meetings exist or to get a botId to drill into. There is no date or query filter " +
    "(only a limit) — scan the returned list yourself; to find meetings by keyword/topic use search_my_meetings. " +
    "Does NOT need a botId — it returns them.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max meetings to return. Default 20."),
  }),
  outputSchema: z.object({
    count: z.number(),
    meetings: z.array(
      z.object({
        botId: z.string(),
        status: z.string(),
        summary: z.string().nullable(),
        participantCount: z.number(),
        meetingUrl: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = (await getSession())?.user?.id;
    if (!userId) return { count: 0, meetings: [] };
    // withUserScope is REQUIRED: listMeetingRecordsForUser calls scopedDb(),
    // which fails-closed (0 rows) outside a scope. Never withSystemScope here —
    // that would return every user's meetings.
    const rows = await withUserScope(userId, () =>
      listMeetingRecordsForUser(input.limit ?? 20),
    );
    return {
      count: rows.length,
      meetings: rows.map((r) => ({
        botId: r.botId,
        status: r.status,
        summary: r.summary,
        participantCount: r.participantCount,
        meetingUrl: r.meetingUrl,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
});

/**
 * LONGITUDINAL team-health: aggregates dynamics ACROSS the user's meetings to
 * show how participation, interruptions and balance evolve over time, and
 * surfaces actionable signals (a fading participant, rising dominance/friction,
 * declining balance) the agent can proactively raise. RLS-scoped to the session
 * user. Needs no botId — it spans all the user's meetings.
 */
export const getTeamTrendsTool = createTool({
  id: "get_team_trends",
  description:
    "Analyzes how the team's meeting dynamics EVOLVE ACROSS meetings over time " +
    "(not one meeting): per-person talk-time trajectory, who is fading or " +
    "dominating more, rising interruptions/friction, and whether the team is " +
    "getting more or less balanced. Returns actionable signals to raise " +
    "proactively (e.g. 'Marina is going quiet'). Use for 'how is our team " +
    "trending', 'is anyone dominating more', 'who's gone quiet', 'is friction " +
    "rising'. Needs NO botId — it spans all the user's meetings.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(3)
      .max(200)
      .optional()
      .describe("Max recent meetings to analyze. Default 50."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    meetings: z.number(),
    signals: z.array(
      z.object({
        kind: z.enum([
          "fading_participant",
          "rising_dominance",
          "rising_friction",
          "declining_balance",
        ]),
        subject: z.string().optional(),
        message: z.string(),
        severity: z.number(),
      }),
    ),
    participants: z.array(
      z.object({
        name: z.string(),
        meetings: z.number(),
        avgTalkShare: z.number(),
        talkShareSlope: z.number(),
        firstShare: z.number(),
        lastShare: z.number(),
        totalInterruptionsMade: z.number(),
      }),
    ),
    balanceSlope: z.number(),
  }),
  execute: async (input) => {
    const userId = (await getSession())?.user?.id;
    if (!userId) {
      return {
        available: false,
        meetings: 0,
        signals: [],
        participants: [],
        balanceSlope: 0,
      };
    }
    // RLS-scoped: only the caller's dynamics snapshots. Never system scope.
    const snapshots = await withUserScope(userId, () =>
      listDynamicsForUser(input.limit ?? 50),
    );
    const trends = computeTeamTrends(snapshots);
    if (!trends) {
      return {
        available: false,
        meetings: snapshots.length,
        signals: [],
        participants: [],
        balanceSlope: 0,
      };
    }
    return {
      available: true,
      meetings: trends.meetings,
      signals: trends.signals,
      participants: trends.participants.map((p) => ({
        name: p.name,
        meetings: p.meetings,
        avgTalkShare: p.avgTalkShare,
        talkShareSlope: p.talkShareSlope,
        firstShare: p.firstShare,
        lastShare: p.lastShare,
        totalInterruptionsMade: p.totalInterruptionsMade,
      })),
      balanceSlope: trends.balanceSlope,
    };
  },
});

/**
 * Cross-meeting search/Q&A: matches a query against the caller's persisted
 * minutes (summary/overview/transcript) and returns the top meetings with a
 * snippet. Powers "what did we decide about pricing across all my meetings?" —
 * the agent searches, reads the hits, and answers, drilling into a specific
 * botId only when it needs more. RLS-scoped to the session user.
 */
export const searchMyMeetingsTool = createTool({
  id: "search_my_meetings",
  description:
    "Searches ACROSS the current user's past meetings by keyword/topic and returns matching meetings " +
    "with a transcript snippet. Use for cross-meeting questions like 'what did we decide about pricing?' " +
    "or 'which meeting mentioned the Q3 launch?'. Then read a hit's summary or call summarize_meeting/get_transcript " +
    "with its botId for detail. Does NOT need a botId.",
  inputSchema: z.object({
    query: z.string().describe("Keyword or phrase to search for across meetings."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Max matching meetings to return. Default 5."),
  }),
  outputSchema: z.object({
    count: z.number(),
    hits: z.array(
      z.object({
        botId: z.string(),
        summary: z.string().nullable(),
        overview: z.string().nullable(),
        topics: z.array(z.string()).nullable(),
        snippet: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = (await getSession())?.user?.id;
    if (!userId) return { count: 0, hits: [] };
    const hits = await withUserScope(userId, () =>
      searchMeetingRecords(input.query, input.limit ?? 5),
    );
    return {
      count: hits.length,
      hits: hits.map((h) => ({
        botId: h.botId,
        summary: h.summary,
        overview: h.overview,
        topics: h.topics,
        snippet: h.snippet,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  },
});

export const listScheduledRecallBotsTool = createTool({
  id: "list_scheduled_recall_bots",
  description:
    "Lists Recall.ai bots scheduled to join meetings from a given time onward (default: now).",
  inputSchema: z.object({
    joinAtAfter: z.iso
      .datetime()
      .optional()
      .describe("ISO 8601. Default: now. Lists bots with join_at after this time."),
  }),
  outputSchema: z.object({
    count: z.number(),
    bots: z.array(
      z.object({
        botId: z.string(),
        status: z.string().optional(),
        joinAt: z.string().nullable().optional(),
      }),
    ),
  }),
  execute: async (input) => {
    // The Recall API key is workspace-wide: `v1/bot/` returns EVERY tenant's
    // bots. Without filtering, any authenticated user could enumerate other
    // users' scheduled meetings. Resolve the caller and keep only bots they own.
    const userId = (await getSession())?.user?.id;
    if (!userId) {
      throw new Error("Not authenticated — cannot list scheduled bots.");
    }

    const joinAtAfter = input.joinAtAfter ?? new Date().toISOString();
    const res = await recallFetch<{ count?: number; results?: RecallBot[] }>({
      method: "GET",
      path: "v1/bot/",
      query: { join_at_after: joinAtAfter },
    });

    const owned = (
      await Promise.all(
        (res.results ?? []).map(async (b) =>
          (await isBotOwner(b.id, userId)) ? b : null,
        ),
      )
    ).filter((b): b is RecallBot => b !== null);

    const bots = owned.map((b) => ({
      botId: b.id,
      status: latestStatus(b),
      joinAt: b.join_at ?? null,
    }));
    return { count: bots.length, bots };
  },
});

/**
 * Cancels/removes a bot.
 * - Scheduled and hasn't joined yet (>10min) → DELETE (unschedules).
 * - Already joining / in call → leave_call (removes from the call).
 * The `force` parameter forces leave_call regardless of state.
 */
export const cancelRecallBotTool = createTool({
  id: "cancel_recall_bot",
  description:
    "Cancels a scheduled bot or removes a bot that's already in a Recall.ai call, by botId. " +
    "Use it to back out of a meeting or to remove the bot from an ongoing call. " +
    "If the bot was scheduled from a connected-calendar event (you have an eventId, not a botId), use remove_bot_from_event instead.",
  inputSchema: z.object({
    botId: z.string().describe("Bot UUID"),
    dedupKey: z
      .string()
      .optional()
      .describe("If provided, clears the app's dedup mapping."),
    force: z
      .boolean()
      .optional()
      .describe("true forces leave_call (removing from the call) instead of unscheduling."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    action: z.enum(["unscheduled", "left_call"]),
  }),
  execute: async (input) => {
    await requireBotOwner(input.botId);
    let action: "unscheduled" | "left_call";

    if (input.force) {
      await recallFetch({
        method: "POST",
        path: `v1/bot/${input.botId}/leave_call/`,
      });
      action = "left_call";
    } else {
      // Tries to unschedule; if the bot already joined (Recall refuses the DELETE), falls back to leave_call.
      try {
        await recallFetch({ method: "DELETE", path: `v1/bot/${input.botId}/` });
        action = "unscheduled";
      } catch {
        await recallFetch({
          method: "POST",
          path: `v1/bot/${input.botId}/leave_call/`,
        });
        action = "left_call";
      }
    }

    if (input.dedupKey) await deleteBotMapping(input.dedupKey);
    return { ok: true, action };
  },
});

/**
 * Starts recording for a bot that's already in the call.
 *
 * Bots record automatically on participant join (start_recording_on:
 * participant_join), so this is only for MANUAL control — e.g. restarting a
 * recording, or starting one after a stop/pause. Restarts the current
 * recording if there already is one.
 */
export const startRecallRecordingTool = createTool({
  id: "start_recall_recording",
  description:
    "Starts recording for a Recall.ai bot that's already in the meeting. " +
    "Bots already record automatically on join, so you rarely need this — use it only for MANUAL control (restarting after a stop/pause). " +
    "By default it also captures the transcript (Recall.ai Transcription). Restarts if it was already recording.",
  inputSchema: z.object({
    botId: z.string().describe("Bot UUID (must be in the call)"),
    transcribe: z
      .boolean()
      .optional()
      .describe("Capture transcript. Default: true."),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await requireBotOwner(input.botId);
    const transcribe = input.transcribe ?? true;
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/start_recording/`,
      body: transcribe
        ? { transcript: { provider: { recallai_streaming: {} } } }
        : {},
    });
    return { ok: true };
  },
});

/** Stops a bot's ongoing recording. */
export const stopRecallRecordingTool = createTool({
  id: "stop_recall_recording",
  description:
    "Stops a Recall.ai bot's ongoing recording. The bot stays in the call.",
  inputSchema: z.object({
    botId: z.string().describe("Bot UUID"),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await requireBotOwner(input.botId);
    await recallFetch({
      method: "POST",
      path: `v1/bot/${input.botId}/stop_recording/`,
    });
    return { ok: true };
  },
});

/**
 * Reads the team-dynamics / meeting-health metrics for a recorded meeting:
 * who dominated the conversation, interruptions, silences, monologues, and how
 * balanced the participation was — the "how the team interacted" layer, distinct
 * from the minutes ("what was said"). Computed during enrichment from the
 * word-level transcript, so it's read straight from our persisted record.
 */
export const getMeetingDynamicsTool = createTool({
  id: "get_meeting_dynamics",
  description:
    "Reads team-dynamics / meeting-health metrics for a meeting, by botId: " +
    "talk-time share per person, who interrupted whom, silences, monologues, " +
    "turn-taking, and an overall participation balance (0..1). Use for " +
    "'how did the team interact', 'who dominated', 'was it balanced', " +
    "'any tension' questions — not for what was decided (that's summarize).",
  inputSchema: z.object({
    botId: z.string().describe("UUID of the bot that recorded the meeting"),
  }),
  outputSchema: z.object({
    botId: z.string(),
    available: z.boolean(),
    dynamics: z
      .object({
        participants: z.array(
          z.object({
            name: z.string(),
            talkShare: z.number(),
            talkSeconds: z.number(),
            turns: z.number(),
            interruptionsMade: z.number(),
            interruptionsReceived: z.number(),
            longestTurnSeconds: z.number(),
          }),
        ),
        totalTalkSeconds: z.number(),
        turnCount: z.number(),
        interruptions: z.number(),
        silenceSeconds: z.number(),
        balance: z.number(),
        moments: z.array(
          z.object({
            kind: z.enum(["interruption", "monologue", "silence"]),
            atSeconds: z.number(),
            durationSeconds: z.number(),
            label: z.string(),
          }),
        ),
      })
      .nullable(),
    // LLM meeting-health read (headline + manager-facing summary + toned
    // moment labels) — the answer to "how did the team interact".
    insight: z
      .object({
        headline: z.string(),
        summary: z.string(),
        moments: z.array(
          z.object({
            atSeconds: z.number(),
            kind: z.enum(["interruption", "monologue", "silence"]),
            label: z.string(),
            tone: z.enum(["tense", "energized", "flat", "neutral"]),
          }),
        ),
      })
      .nullable(),
  }),
  execute: async (input) => {
    const userId = await requireBotOwner(input.botId);
    const record = await withUserScope(userId, () =>
      findMeetingRecord(input.botId),
    );
    const dynamics = record?.dynamics ?? null;
    const insight = record?.dynamicsInsight ?? null;
    return {
      botId: input.botId,
      available: dynamics != null,
      dynamics,
      insight,
    };
  },
});
