"use client";

import {
  CalendarPlusIcon,
  VideoIcon,
  CircleIcon,
  SquareIcon,
  PauseIcon,
  PlayIcon,
  CalendarSearchIcon,
  CalendarCheckIcon,
  CalendarXIcon,
  BotIcon,
  FileTextIcon,
  ExternalLinkIcon,
  LoaderIcon,
  CheckIcon,
  ListChecksIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { cn } from "@/shared/lib/utils";

/**
 * ToolUIs for the meeting agent — visual cards that REPLACE the raw JSON of
 * tool-calls. Each one maps a local tool (create_calendar_event, bots,
 * recording, calendar) to a card with what the user needs to see.
 *
 * Registered in the Assistant's AssistantRuntimeProvider. Without
 * registration, the tool falls back to ToolFallback (JSON). With
 * registration, the user only sees the essentials.
 */

function shortId(id: string | undefined | null) {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** Shortens a meeting URL to readable "host/id", without truncating mid-string. */
function shortMeetUrl(url: string | undefined | null): string {
  // Tool args stream in incrementally: during status="running" the field may
  // not have arrived yet, so guard the undefined case before touching it.
  if (!url) return "—";
  try {
    const u = new URL(url);
    const id = u.pathname.replace(/^\/+/, "").split("/")[0] || "";
    return id ? `${u.host}/${id}` : u.host;
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url;
  }
}

/** Formats an ISO string as "dd/mm HH:MM" in the browser's local timezone. */
function fmtTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── create_calendar_event ─────────────────────────────────────────── */

export const CreateEventToolUI = makeAssistantToolUI<
  { summary: string; startIso: string; endIso: string; sendBot?: boolean },
  {
    ok: boolean;
    eventId: string;
    htmlLink: string;
    meetingUrl: string | null;
    botId: string | null;
  }
>({
  toolName: "create_calendar_event",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return (
        <ToolCard
          icon={CalendarPlusIcon}
          label="create meeting"
          running
          meta={args.summary}
        />
      );
    if (!result?.ok) return null;
    return (
      <ToolCard icon={CalendarPlusIcon} label="meeting created" tone="success">
        <Row k="title" v={args.summary} />
        <Row k="start" v={fmtTime(args.startIso)} />
        <Row k="end" v={fmtTime(args.endIso)} />
        {result.botId ? (
          <Row k="bot" v={`recording · ${shortId(result.botId)}`} />
        ) : null}
        {result.meetingUrl ? (
          <>
            <Dashed />
            <LinkRow
              icon={VideoIcon}
              label="join google meet"
              href={result.meetingUrl}
            />
          </>
        ) : null}
        {result.htmlLink ? (
          <LinkRow
            icon={ExternalLinkIcon}
            label="open in calendar"
            href={result.htmlLink}
          />
        ) : null}
      </ToolCard>
    );
  },
});

/* ── send_bot_to_meeting ───────────────────────────────────────────── */

export const SendBotToolUI = makeAssistantToolUI<
  { meetingUrl: string; botName?: string; joinAt?: string },
  { ok: boolean; botId: string; reused: boolean; scheduled: boolean }
>({
  toolName: "send_bot_to_meeting",
  render: ({ args, result, status }) => {
    if (status.type === "running")
      return (
        <ToolCard
          icon={BotIcon}
          label="send bot"
          running
          meta={shortMeetUrl(args.meetingUrl)}
        />
      );
    if (!result?.ok) return null;
    return (
      <ToolCard
        icon={BotIcon}
        label={result.scheduled ? "bot scheduled" : "bot sent"}
        tone="success"
        meta={result.reused ? "reused" : undefined}
      >
        <Row k="meeting" v={shortMeetUrl(args.meetingUrl)} />
        {args.joinAt ? <Row k="joins at" v={fmtTime(args.joinAt)} /> : null}
        <Row k="bot" v={shortId(result.botId)} />
        <Row k="recording" v="auto on join" />
      </ToolCard>
    );
  },
});

/* ── recording: start / stop / pause / resume ──────────────────────── */

function makeRecordingUI(
  toolName: string,
  label: string,
  icon: LucideIcon,
  tone: Tone,
) {
  return makeAssistantToolUI<{ botId: string }, { ok: boolean }>({
    toolName,
    render: ({ result, status }) => {
      if (status.type === "running")
        return <ToolCard icon={icon} label={label} running />;
      if (!result?.ok) return null;
      return <ToolCard icon={icon} label={label} tone={tone} meta="ok" />;
    },
  });
}

export const StartRecordingToolUI = makeRecordingUI(
  "start_recording",
  "recording started",
  CircleIcon,
  "success",
);
export const StopRecordingToolUI = makeRecordingUI(
  "stop_recording",
  "recording stopped",
  SquareIcon,
  "default",
);
export const PauseRecordingToolUI = makeRecordingUI(
  "pause_recording",
  "recording paused",
  PauseIcon,
  "caution",
);
export const ResumeRecordingToolUI = makeRecordingUI(
  "resume_recording",
  "recording resumed",
  PlayIcon,
  "success",
);

/* ── remove_bot ────────────────────────────────────────────────────── */

export const RemoveBotToolUI = makeAssistantToolUI<
  { botId: string },
  { ok: boolean; action: "unscheduled" | "left_call" }
>({
  toolName: "remove_bot",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={CalendarXIcon} label="remove bot" running />;
    if (!result?.ok) return null;
    const meta =
      result.action === "left_call" ? "left the call" : "unscheduled";
    return <ToolCard icon={CalendarXIcon} label="bot removed" meta={meta} />;
  },
});

/* ── list_calendar_events ──────────────────────────────────────────── */

type EventRow = {
  eventId: string;
  startTime: string;
  meetingUrl: string | null;
  platform: string | null;
  scheduledBots: number;
};

export const ListEventsToolUI = makeAssistantToolUI<
  Record<string, never>,
  { count: number; events: EventRow[] }
>({
  toolName: "list_calendar_events",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={CalendarSearchIcon} label="fetch events" running />;
    if (!result) return null;
    // events may arrive undefined (partial response during streaming or a
    // tool error); normalize before any .slice/.length.
    const events = result.events ?? [];
    if (result.count === 0 || events.length === 0)
      return (
        <ToolCard
          icon={CalendarSearchIcon}
          label="upcoming events"
          meta="none"
        />
      );
    return (
      <ToolCard
        icon={CalendarSearchIcon}
        label="upcoming events"
        meta={`${result.count}`}
      >
        {events.slice(0, 8).map((e) => (
          <div
            key={e.eventId}
            className="flex items-center gap-2 rounded-[5px] border bg-background px-2.5 py-1.5"
          >
            <CalendarCheckIcon className="size-3 shrink-0 text-(--thread-accent-primary)" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {fmtTime(e.startTime)}
            </span>
            {e.meetingUrl ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {e.platform ?? "meet"}
              </span>
            ) : null}
            {e.scheduledBots > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-[4px] bg-(--thread-accent-primary-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--thread-accent-primary)">
                <BotIcon className="size-2.5" />
                {e.scheduledBots}
              </span>
            ) : null}
          </div>
        ))}
      </ToolCard>
    );
  },
});

/* ── schedule_bot_for_event / remove_bot_from_event ────────────────── */

export const ScheduleEventBotToolUI = makeAssistantToolUI<
  { eventId: string },
  { ok: boolean; eventId: string; scheduledBots: number }
>({
  toolName: "schedule_bot_for_event",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={CalendarCheckIcon} label="schedule bot for event" running />;
    if (!result?.ok) return null;
    return (
      <ToolCard
        icon={CalendarCheckIcon}
        label="bot scheduled for event"
        tone="success"
        meta={`${result.scheduledBots} bot(s)`}
      />
    );
  },
});

export const RemoveEventBotToolUI = makeAssistantToolUI<
  { eventId: string },
  { ok: boolean; eventId: string }
>({
  toolName: "remove_bot_from_event",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={CalendarXIcon} label="remove bot from event" running />;
    if (!result?.ok) return null;
    return <ToolCard icon={CalendarXIcon} label="bot removed from event" />;
  },
});

/* ── get_transcript ────────────────────────────────────────────────── */

export const TranscriptToolUI = makeAssistantToolUI<
  { botId: string },
  {
    botId: string;
    state: "ready" | "processing" | "none";
    transcript: string | null;
    speakers?: string[];
  }
>({
  toolName: "get_transcript",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={FileTextIcon} label="read transcript" running />;
    if (!result) return null;
    if (result.state === "processing")
      return (
        <ToolCard
          icon={FileTextIcon}
          label="transcript"
          meta="processing…"
        />
      );
    if (result.state === "none" || !result.transcript)
      return (
        <ToolCard icon={FileTextIcon} label="transcript" meta="unavailable" />
      );
    return (
      <ToolCard
        icon={FileTextIcon}
        label="transcript"
        tone="success"
        meta={
          result.speakers?.length
            ? `${result.speakers.length} participant(s)`
            : undefined
        }
      >
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">
          {result.transcript}
        </pre>
      </ToolCard>
    );
  },
});

/* ── get_recording ─────────────────────────────────────────────────── */

type MediaRow = {
  kind: string;
  status: string | null;
  downloadUrl: string | null;
};

export const RecordingToolUI = makeAssistantToolUI<
  { botId: string },
  { botId: string; recordingStatus: string | null; media: MediaRow[] }
>({
  toolName: "get_recording",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={VideoIcon} label="fetch recording" running />;
    if (!result) return null;
    const labels: Record<string, string> = {
      video_mixed: "video",
      audio_mixed: "audio",
      transcript: "transcript",
    };
    return (
      <ToolCard
        icon={VideoIcon}
        label="recording"
        meta={result.recordingStatus ?? undefined}
      >
        {result.media.map((m) => (
          <div
            key={m.kind}
            className="flex items-center justify-between gap-3 rounded-[5px] border bg-background px-2.5 py-1.5"
          >
            <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
              {labels[m.kind] ?? m.kind}
            </span>
            {m.downloadUrl ? (
              <a
                href={m.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
              >
                <ExternalLinkIcon className="size-3" />
                download
              </a>
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {m.status ?? "—"}
              </span>
            )}
          </div>
        ))}
      </ToolCard>
    );
  },
});

/* ── summarize_meeting ─────────────────────────────────────────────── */

type ActionItem = { task: string; owner: string | null };

type SummaryResult = {
  botId: string;
  state: "ready" | "processing" | "none";
  summary: string | null;
  decisions?: string[];
  actionItems?: ActionItem[];
  topics?: string[];
};

/**
 * Minutes card — shows the summary/decisions/action items/topics from a
 * meeting's transcript.
 */
function SummaryCard({ result }: { result: SummaryResult }) {
  return (
    <ToolCard icon={ListChecksIcon} label="meeting summary" tone="success">
      <p className="text-sm leading-relaxed text-foreground/90">
        {result.summary}
      </p>

      {result.decisions?.length ? (
        <>
          <Dashed />
          <SectionTitle>decisions</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {result.decisions.map((d, i) => (
              <li
                key={i}
                className="flex items-start gap-2 rounded-[5px] border bg-background px-2.5 py-1.5 text-sm"
              >
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-(--thread-accent-primary)" />
                <span className="min-w-0">{d}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {result.actionItems?.length ? (
        <>
          <Dashed />
          <SectionTitle>action items</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {result.actionItems.map((a, i) => (
              <li
                key={i}
                className="flex items-start justify-between gap-3 rounded-[5px] border bg-background px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 text-sm">{a.task}</span>
                {a.owner ? (
                  <span className="shrink-0 rounded-[4px] bg-(--thread-accent-primary-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--thread-accent-primary)">
                    {a.owner}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {result.topics?.length ? (
        <>
          <Dashed />
          <div className="flex flex-wrap gap-1.5">
            {result.topics.map((t, i) => (
              <span
                key={i}
                className="rounded-[4px] border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </ToolCard>
  );
}

export const SummarizeToolUI = makeAssistantToolUI<
  { botId: string; focus?: string },
  SummaryResult
>({
  toolName: "summarize_meeting",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={ListChecksIcon} label="summarize meeting" running />;
    if (!result) return null;
    if (result.state === "processing")
      return (
        <ToolCard icon={ListChecksIcon} label="summary" meta="processing…" />
      );
    if (result.state === "none" || !result.summary)
      return (
        <ToolCard icon={ListChecksIcon} label="summary" meta="unavailable" />
      );
    return <SummaryCard result={result} />;
  },
});

/* ── get_participants ──────────────────────────────────────────────── */

type ParticipantRow = {
  name: string;
  isHost: boolean | null;
  speakingSeconds: number;
};

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export const ParticipantsToolUI = makeAssistantToolUI<
  { botId: string },
  {
    botId: string;
    state: "ready" | "processing" | "none";
    participants?: ParticipantRow[];
  }
>({
  toolName: "get_participants",
  render: ({ result, status }) => {
    if (status.type === "running")
      return <ToolCard icon={UsersIcon} label="view participants" running />;
    if (!result) return null;
    if (result.state !== "ready" || !result.participants?.length)
      return (
        <ToolCard
          icon={UsersIcon}
          label="participants"
          meta={result.state === "processing" ? "processing…" : "unavailable"}
        />
      );

    const max = Math.max(
      1,
      ...result.participants.map((p) => p.speakingSeconds),
    );
    return (
      <ToolCard
        icon={UsersIcon}
        label="participants"
        tone="success"
        meta={`${result.participants.length}`}
      >
        {result.participants.map((p, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm">{p.name}</span>
                {p.isHost ? (
                  <span className="shrink-0 rounded-[4px] bg-(--thread-accent-primary-soft) px-1 py-0.5 font-mono text-[9px] text-(--thread-accent-primary)">
                    host
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {fmtDuration(p.speakingSeconds)}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-(--thread-frame-outer)">
              <div
                className="h-full rounded-full bg-(--thread-accent-primary)"
                style={{ width: `${(p.speakingSeconds / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </ToolCard>
    );
  },
});

/** Groups all the meeting agent's ToolUIs into a single component. */
export function MeetingToolUIs() {
  return (
    <>
      <CreateEventToolUI />
      <SendBotToolUI />
      <TranscriptToolUI />
      <RecordingToolUI />
      <SummarizeToolUI />
      <ParticipantsToolUI />
      <StartRecordingToolUI />
      <StopRecordingToolUI />
      <PauseRecordingToolUI />
      <ResumeRecordingToolUI />
      <RemoveBotToolUI />
      <ListEventsToolUI />
      <ScheduleEventBotToolUI />
      <RemoveEventBotToolUI />
    </>
  );
}

/* ── visual primitives ───────────────────────────────────────────── */

type Tone = "default" | "success" | "caution" | "risk";

function ToolCard({
  icon: Icon,
  label,
  meta,
  tone = "default",
  running = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  tone?: Tone;
  running?: boolean;
  children?: React.ReactNode;
}) {
  const accent =
    tone === "success"
      ? "bg-(--thread-accent-primary)"
      : tone === "caution"
        ? "bg-amber-500"
        : tone === "risk"
          ? "bg-(--thread-accent-secondary)"
          : "bg-(--thread-accent-secondary)";

  return (
    <div className="my-2 rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          {running ? (
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
          ) : (
            <Icon className="size-3.5" />
          )}
          meeting / {label}
        </span>
        {running ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 animate-pulse rounded-[1px]", accent)}
            />
            running
          </span>
        ) : tone === "success" ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
            <CheckIcon className="size-3" />
            {meta ?? "done"}
          </span>
        ) : (
          meta && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span aria-hidden className={cn("size-2 rounded-[1px]", accent)} />
              {meta}
            </span>
          )
        )}
      </div>

      {children && (
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-3">
          {children}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
        {k}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-sm">{v}</span>
    </div>
  );
}

function LinkRow({
  icon: Icon,
  label,
  href,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
    >
      <Icon className="size-3" />
      {label}
    </a>
  );
}

function Dashed() {
  return <div className="my-1 border-t border-dashed border-border" />;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
      {children}
    </span>
  );
}
