"use client";

/**
 * Public, read-only meeting view served at /share/[token]. Same terminal
 * aesthetic as the owner's notebook (player + karaoke transcript + AI panels)
 * but WITHOUT auth, chat, clipping, or recovery actions — just the shared
 * minutes. The Server Component resolves the token and passes the persisted,
 * serializable meeting data here; this component owns only browser interaction.
 */

import { useMemo, useRef, useState } from "react";
import {
  FileTextIcon,
  SparklesIcon,
  ListChecksIcon,
  HashIcon,
  UsersIcon,
  ClockIcon,
  CalendarIcon,
  CheckIcon,
  HashIcon as TopicIcon,
  ZapIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type {
  PublicMeetingResponse,
  MeetingMoment,
} from "@/features/meetings/model/queries";

/* ── helpers ──────────────────────────────────────────────────────── */

const SPEAKER_HUES = [150, 8, 250, 70, 300, 190];
function speakerColor(index: number): string {
  const hue = SPEAKER_HUES[index % SPEAKER_HUES.length];
  return `oklch(0.65 0.15 ${hue})`;
}

function fmtDurationLabel(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

const MOMENT_ICON: Record<MeetingMoment["kind"], LucideIcon> = {
  topic: TopicIcon,
  action: ZapIcon,
  question: MessageCircleQuestionIcon,
  objection: ShieldAlertIcon,
};

/* ── root ─────────────────────────────────────────────────────────── */

export function PublicMeetingView({ data }: { data: PublicMeetingResponse }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [transcriptQuery, setTranscriptQuery] = useState("");

  const speakerIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (const utt of data?.transcript ?? []) {
      if (!map.has(utt.speaker)) map.set(utt.speaker, map.size);
    }
    return map;
  }, [data?.transcript]);

  function seek(seconds: number | null) {
    if (seconds == null || !videoRef.current) return;
    videoRef.current.currentTime = seconds;
    void videoRef.current.play();
  }

  const speakers = [...speakerIndex.keys()];
  const duration = fmtDurationLabel(data.durationSeconds);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-3 bg-(--thread-frame-outer) p-4 font-sans text-foreground">
      {/* header */}
      <header className="flex shrink-0 flex-col gap-2 rounded-[8px] border bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-[5px] border bg-background">
            <FileTextIcon className="size-4 text-(--thread-accent-primary)" />
          </span>
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 rounded-[1px] bg-(--thread-accent-primary)"
              />
              shared meeting · read-only
            </span>
            <h1 className="max-w-md truncate text-sm font-semibold tracking-tight">
              {data.title}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11px] text-muted-foreground">
          <Meta icon={CalendarIcon} v={new Date(data.createdAt).toLocaleDateString()} />
          {duration && <Meta icon={ClockIcon} v={duration} />}
          {speakers.length > 0 && (
            <Meta icon={UsersIcon} v={`${speakers.length} speakers`} />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* LEFT — player + transcript */}
        <section className="flex min-h-0 flex-[1.4] flex-col gap-1 rounded-[8px] bg-(--thread-frame-outer) p-1">
          <PanelLabel icon={FileTextIcon}>meeting / transcript</PanelLabel>

          {speakers.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-dashed border-border px-3 py-2">
              {speakers.map((name, i) => (
                <span
                  key={name}
                  className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-[1px]"
                    style={{ background: speakerColor(i) }}
                  />
                  {name}
                </span>
              ))}
            </div>
          )}

          {data.videoUrl ? (
            <video
              ref={videoRef}
              src={data.videoUrl}
              controls
              className="aspect-video max-h-64 w-full rounded-[5px] border bg-black"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            />
          ) : (
            <div className="flex aspect-video max-h-64 w-full items-center justify-center rounded-[5px] border bg-black/90 font-mono text-[11px] uppercase tracking-wider text-white/60">
              no video for this meeting
            </div>
          )}

          <Transcript
            data={data}
            currentTime={time}
            speakerIndex={speakerIndex}
            onSeek={seek}
            query={transcriptQuery}
            onQueryChange={setTranscriptQuery}
          />
        </section>

        {/* RIGHT — AI panels */}
        <aside className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Panels data={data} onSeek={seek} />
        </aside>
      </div>

      <footer className="shrink-0 py-3 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        shared via casper · read-only meeting minutes
      </footer>
    </div>
  );
}

/* ── transcript (karaoke, read-only) ──────────────────────────────── */

function Transcript({
  data,
  currentTime,
  speakerIndex,
  onSeek,
  query,
  onQueryChange,
}: {
  data: PublicMeetingResponse;
  currentTime: number;
  speakerIndex: Map<string, number>;
  onSeek: (s: number | null) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const utterances = useMemo(() => {
    if (!q) return data.transcript;
    return data.transcript.filter((u) =>
      u.words.some((w) => w.text.toLowerCase().includes(q)),
    );
  }, [data.transcript, q]);

  if (data.transcript.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-8 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        no transcript for this meeting
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-dashed border-border px-3 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="search transcript…"
          className="w-full bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {utterances.length === 0 ? (
          <p className="py-6 text-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            no lines match “{query}”
          </p>
        ) : (
          utterances.map((u, i) => {
            const color = speakerColor(speakerIndex.get(u.speaker) ?? 0);
            return (
              <div
                key={i}
                // content-visibility: mesma otimização do notebook privado —
                // pula layout/paint das utterances fora da viewport no
                // transcript longo. contain-intrinsic-size reserva a altura.
                className="flex flex-col gap-1 [contain-intrinsic-size:auto_64px] [content-visibility:auto]"
              >
                <button
                  type="button"
                  onClick={() => onSeek(u.start)}
                  className="flex items-center gap-2 self-start font-mono text-[10px] uppercase tracking-wider hover:underline"
                  style={{ color }}
                >
                  {u.speaker}
                  {u.start != null && (
                    <span className="text-muted-foreground">
                      {Math.floor(u.start / 60)}:
                      {String(Math.floor(u.start % 60)).padStart(2, "0")}
                    </span>
                  )}
                </button>
                <p className="text-[13px] leading-relaxed">
                  {u.words.map((w, wi) => {
                    const active =
                      w.start != null &&
                      w.end != null &&
                      currentTime >= w.start &&
                      currentTime < w.end;
                    const match = q && w.text.toLowerCase().includes(q);
                    return (
                      <span
                        key={wi}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSeek(w.start)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") onSeek(w.start);
                        }}
                        className={cn(
                          "cursor-pointer rounded-[2px] px-px",
                          active && "bg-(--thread-accent-primary)/25",
                          match && "bg-(--thread-accent-secondary)/30",
                        )}
                      >
                        {w.text}{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── AI panels (read-only) ────────────────────────────────────────── */

function Panels({
  data,
  onSeek,
}: {
  data: PublicMeetingResponse;
  onSeek: (s: number | null) => void;
}) {
  return (
    <>
      {(data.summary || data.overview) && (
        <Panel icon={SparklesIcon} title="ai / summary">
          {data.summary && (
            <p className="text-[13px] leading-relaxed">{data.summary}</p>
          )}
          {data.overview && (
            <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
              {data.overview}
            </p>
          )}
        </Panel>
      )}

      {data.moments.length > 0 && (
        <Panel icon={ZapIcon} title="key moments">
          <ul className="space-y-1.5">
            {data.moments.map((m, i) => {
              const Icon = MOMENT_ICON[m.kind];
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onSeek(m.atSeconds)}
                    className="flex w-full items-center gap-2 text-left text-[12px] hover:underline"
                  >
                    <Icon className="size-3.5 shrink-0 text-(--thread-accent-primary)" />
                    <span className="flex-1">{m.label}</span>
                    {m.atSeconds != null && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {Math.floor(m.atSeconds / 60)}:
                        {String(Math.floor(m.atSeconds % 60)).padStart(2, "0")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {data.sections.length > 0 && (
        <Panel icon={FileTextIcon} title="sections">
          <ul className="space-y-2">
            {data.sections.map((s, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onSeek(s.startSeconds)}
                  className="font-mono text-[11px] uppercase tracking-wider text-foreground hover:underline"
                >
                  {s.title}
                </button>
                <ul className="mt-1 space-y-0.5">
                  {s.bullets.map((b, bi) => (
                    <li
                      key={bi}
                      className="flex gap-1.5 text-[12px] text-muted-foreground"
                    >
                      <span aria-hidden>·</span>
                      {b}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data.decisions.length > 0 && (
        <Panel icon={CheckIcon} title="decisions">
          <ul className="space-y-1">
            {data.decisions.map((d, i) => (
              <li key={i} className="flex gap-1.5 text-[12px]">
                <CheckIcon className="size-3.5 shrink-0 text-(--thread-accent-primary)" />
                {d}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data.actionItems.length > 0 && (
        <Panel icon={ListChecksIcon} title="action items">
          <ul className="space-y-1.5">
            {data.actionItems.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <span
                  aria-hidden
                  className="mt-1 size-1.5 shrink-0 rounded-[1px] bg-(--thread-accent-secondary)"
                />
                <span className="flex-1">
                  {a.task}
                  {a.owner && (
                    <span className="ml-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      · {a.owner}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {data.topics.length > 0 && (
        <Panel icon={HashIcon} title="topics">
          <div className="flex flex-wrap gap-1.5">
            {data.topics.map((t, i) => (
              <span
                key={i}
                className="rounded-[5px] border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </Panel>
      )}

      {data.talkShares.length > 0 && (
        <Panel icon={UsersIcon} title="talk time">
          <ul className="space-y-1.5">
            {data.talkShares.map((s, i) => (
              <li key={i} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
                  <span>{s.name}</span>
                  <span className="text-muted-foreground">
                    {Math.round(s.share * 100)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-[1px] bg-muted">
                  <div
                    className="h-full bg-(--thread-accent-primary)"
                    style={{ width: `${Math.round(s.share * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

/* ── primitives ───────────────────────────────────────────────────── */

function Meta({ icon: Icon, v }: { icon: LucideIcon; v: string }) {
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      <Icon className="size-3.5" />
      {v}
    </span>
  );
}

function PanelLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5" />
      {children}
    </div>
  );
}

function Panel({
  icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[8px] bg-(--thread-frame-outer) p-1">
      <PanelLabel icon={icon}>{title}</PanelLabel>
      <div className="rounded-[5px] border bg-background px-3 py-2.5">
        {children}
      </div>
    </div>
  );
}
