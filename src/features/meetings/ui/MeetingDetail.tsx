"use client";

/**
 * Meeting notebook (real data) — post-meeting surface casada com a identidade
 * EvilCharts/terminal do assistant: frame outer + header mono uppercase, inner
 * card `border bg-background`, pulse dots, accents oklch primary/secondary.
 *
 * Fonte: useMeetingDetail(botId) → GET /api/meetings/:botId (minutes + video +
 * transcript word-level persistidos em meeting_records). Diferente do mock, o
 * player toca o mp4 REAL (video_mixed, HTML5 nativo, sync via `timeupdate`) e o
 * transcript é o karaoke real (palavra ativa destacada). Clicar palavra /
 * seção / momento / soundbite dá seek no vídeo.
 *
 * Layout de 2 colunas dentro do painel esquerdo (o Thread real vive à direita,
 * montado pela página via AssistantSidebar). Sem dependências externas de
 * player.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileTextIcon,
  SparklesIcon,
  ListChecksIcon,
  HashIcon,
  UsersIcon,
  ClockIcon,
  CalendarIcon,
  Share2Icon,
  LinkIcon,
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  CheckIcon,
  XIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  ZapIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  BookmarkIcon,
  ScissorsIcon,
  QuoteIcon,
  SearchIcon,
  ActivityIcon,
  MicOffIcon,
  RadioIcon,
  FlameIcon,
  MonitorIcon,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import {
  useMeetingDetail,
  HttpError,
  type MeetingDetailResponse,
  type MeetingMoment,
  type MeetingSoundbite,
  type MeetingActionItem,
  type MeetingDynamics,
  type MeetingHealthInsight,
} from "@/features/meetings/model/queries";
import { useClip, type ClipState } from "@/features/meetings/model/useClip";
import { useTensionAnalysis } from "@/features/meetings/model/useTensionAnalysis";
import { useScreenIntelligence } from "@/features/meetings/model/useScreenIntelligence";
import {
  setMeetingShare,
  deleteMeeting,
  updateMeetingTitle,
  updateMeetingSummary,
  updateMeetingActionItems,
  renameMeetingSpeaker,
} from "@/features/meetings/api/actions";
import type {
  ScreenshareSpan,
  ScreenCapture,
  TranscriptUtterance,
} from "@/features/meetings/model/queries";

/* ── helpers ──────────────────────────────────────────────────────── */

/** Deterministic oklch color per speaker (stable across renders). */
const SPEAKER_HUES = [150, 8, 250, 70, 300, 190];
function speakerColor(index: number): string {
  const hue = SPEAKER_HUES[index % SPEAKER_HUES.length];
  return `oklch(0.65 0.15 ${hue})`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** "12m" / "1h 05m" compact duration for the header. Null-safe. */
function fmtDurationLabel(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** kebab-case a label for a download filename. */
function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "moment"
  );
}

const MOMENT_ICON: Record<MeetingMoment["kind"], LucideIcon> = {
  topic: HashIcon,
  action: ZapIcon,
  question: MessageCircleQuestionIcon,
  objection: ShieldAlertIcon,
};

/* ── root ─────────────────────────────────────────────────────────── */

export function MeetingDetail({ botId }: { botId: string }) {
  const { data, isLoading, error, refetch, isRefetching } =
    useMeetingDetail(botId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const clip = useClip();

  // Speaker index map (stable order = order of first appearance).
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

  if (isLoading) {
    return <MeetingDetailSkeleton />;
  }
  if (error || !data) {
    const status = error instanceof HttpError ? error.status : 0;
    const { text, canRetry } =
      status === 404
        ? { text: "meeting not found — it may have been removed", canRetry: false }
        : status === 401
          ? { text: "session expired — sign in again to view this meeting", canRetry: false }
          : { text: "could not load this meeting", canRetry: true };
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="font-mono text-xs text-(--thread-accent-secondary)">
            {text}
          </p>
          {canRetry && (
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="rounded-[5px] border bg-background px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {isRefetching ? "retrying…" : "retry"}
            </button>
          )}
        </div>
      </Shell>
    );
  }

  const speakers = [...speakerIndex.keys()];

  return (
    <Shell>
      {/* top bar — wraps on narrow viewports (MacBook 13"/notebook) instead of
          the title fighting the meta+actions row for a fixed width. */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[8px] border bg-background px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[5px] border bg-background">
            <FileTextIcon className="size-4 text-(--thread-accent-primary)" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
              />
              notebook · recall.ai
            </span>
            <TitleControl
              botId={botId}
              title={data.title}
              fallback={
                data.summary?.split(/(?<=[.!?])\s/)[0] ?? "Meeting notebook"
              }
              onEdited={refetch}
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 font-mono text-[11px] text-muted-foreground">
          <Meta icon={CalendarIcon} v={new Date(data.createdAt).toLocaleDateString()} />
          {fmtDurationLabel(data.durationSeconds) && (
            <Meta icon={ClockIcon} v={fmtDurationLabel(data.durationSeconds)!} />
          )}
          {speakers.length > 0 && (
            <Meta icon={UsersIcon} v={`${speakers.length} speakers`} />
          )}
          <ExportControl data={data} />
          <ShareControl botId={botId} initialToken={data.shareToken} />
          <DeleteControl botId={botId} />
        </div>
      </header>

      {/* 2 columns on desktop; stacks vertically on small screens. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* LEFT — player + transcript */}
        <section className="flex min-h-0 flex-[1.4] flex-col gap-1 rounded-[8px] bg-(--thread-frame-outer) p-1">
          <PanelLabel icon={FileTextIcon}>meeting / transcript</PanelLabel>

          {/* speaker legend — each name is renamable by the owner */}
          {speakers.length > 0 && (
            <SpeakerLegend
              botId={botId}
              speakers={speakers}
              onRenamed={refetch}
            />
          )}

          <VideoPanel
            videoUrl={data.videoUrl}
            transcriptState={data.transcriptState}
            videoRef={videoRef}
            onTime={setTime}
          />

          <TranscriptPanel
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
          <NotesPanels data={data} onSeek={seek} clip={clip} onEdited={refetch} />
        </aside>
      </div>
    </Shell>
  );
}

/* ── shell ────────────────────────────────────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden bg-(--thread-frame-outer) p-4 font-sans text-foreground">
      {children}
    </div>
  );
}

/* ── loading skeleton ─────────────────────────────────────────────── */

/** Bloco base do skeleton (pulse + bg-muted), casando com o padrão do app. */
function SkeletonBar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block animate-pulse rounded bg-muted", className)}
    />
  );
}

/**
 * Skeleton do notebook — espelha o layout real (header + player + transcript à
 * esquerda, painéis de IA à direita) enquanto useMeetingDetail resolve. Vive
 * dentro do mesmo Shell, então o frame não pisca ao trocar por conteúdo.
 */
function MeetingDetailSkeleton() {
  return (
    <Shell>
      <div aria-busy aria-label="loading minutes" className="contents">
        {/* top bar */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[8px] border bg-background px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <SkeletonBar className="size-8 shrink-0 rounded-[5px]" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <SkeletonBar className="h-2.5 w-36" />
              <SkeletonBar className="h-3.5 w-52" />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <SkeletonBar className="h-3 w-20" />
            <SkeletonBar className="h-3 w-14" />
            <SkeletonBar className="h-6 w-16 rounded-[5px]" />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
          {/* LEFT — player + transcript */}
          <section className="flex min-h-0 flex-[1.4] flex-col gap-1 rounded-[8px] bg-(--thread-frame-outer) p-1">
            <SkeletonBar className="mx-3 my-2 h-2.5 w-40" />
            <SkeletonBar className="aspect-video max-h-64 w-full rounded-[5px]" />
            <div className="mt-1 space-y-4 px-3 py-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBar className="h-2.5 w-24" />
                  <SkeletonBar className="h-3 w-full" />
                  <SkeletonBar className="h-3 w-4/5" />
                </div>
              ))}
            </div>
          </section>

          {/* RIGHT — AI panels */}
          <aside className="flex min-h-0 flex-1 flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="rounded-[8px] bg-(--thread-frame-outer) p-1"
              >
                <SkeletonBar className="mx-3 my-2 h-2.5 w-28" />
                <div className="space-y-2 rounded-[5px] border bg-background px-3 py-2.5">
                  <SkeletonBar className="h-3 w-full" />
                  <SkeletonBar className="h-3 w-11/12" />
                  <SkeletonBar className="h-3 w-3/4" />
                </div>
              </div>
            ))}
          </aside>
        </div>
      </div>
    </Shell>
  );
}

/* ── share control (public link) ──────────────────────────────────── */

/**
 * Owner-only Share control in the notebook header. Toggles a public read-only
 * link (/share/[token]) via the setMeetingShare Server Action, and lets the
 * owner copy or revoke it. Optimistic-free: waits for the action to resolve so
 * the shown token is always the real one.
 */
function ShareControl({
  botId,
  initialToken,
}: {
  botId: string;
  initialToken: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the local token in sync if the detail refetches (e.g. after polling)
  // WITHOUT an effect: adjust state during render when the incoming prop changed
  // (React's "derive during render" pattern). Our own toggle still wins until
  // the next server value arrives.
  const [prevInitial, setPrevInitial] = useState(initialToken);
  if (initialToken !== prevInitial) {
    setPrevInitial(initialToken);
    setToken(initialToken);
  }

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const shareUrl = token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/share/${token}`
    : null;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    const res = await setMeetingShare(botId, enabled);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken(res.shareToken);
  }

  async function copy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("could not copy");
    }
  }

  const shared = Boolean(token);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Share meeting"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 rounded-[5px] border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors hover:bg-muted/60",
          shared
            ? "border-(--thread-accent-primary)/40 text-(--thread-accent-primary)"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Share2Icon className="size-3.5" />
        {shared ? "shared" : "share"}
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-72 rounded-[8px] border bg-background p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <LinkIcon className="size-3.5" />
              public link
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={shared}
              disabled={busy}
              onClick={() => toggle(!shared)}
              className={cn(
                "relative h-4 w-7 rounded-full transition-colors disabled:opacity-50",
                shared ? "bg-(--thread-accent-primary)" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-3 rounded-full bg-background transition-transform",
                  shared ? "translate-x-3.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {shared
              ? "Anyone with this link can view the minutes, transcript and recording — read-only."
              : "Create a read-only link anyone can open, no sign-in required."}
          </p>

          {busy && (
            <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              updating…
            </div>
          )}

          {shared && shareUrl && !busy && (
            <div className="mt-2 flex items-center gap-1.5 rounded-[5px] border bg-muted/40 px-2 py-1">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none"
              />
              <button
                type="button"
                onClick={copy}
                aria-label="Copy link"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <CheckIcon className="size-3.5 text-(--thread-accent-primary)" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </button>
            </div>
          )}

          {error && (
            <p className="mt-2 font-mono text-[10px] text-(--thread-accent-secondary)">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── export control (download minutes + transcript as markdown) ───── */

/** Assembles the meeting minutes + transcript into a portable markdown doc. */
function buildMarkdown(data: MeetingDetailResponse): string {
  const title =
    data.title?.trim() ||
    data.summary?.split(/(?<=[.!?])\s/)[0] ||
    "Meeting notebook";
  const lines: string[] = [`# ${title}`, ""];
  lines.push(`_${new Date(data.createdAt).toLocaleString()}_`, "");

  if (data.summary) lines.push("## Summary", "", data.summary, "");
  if (data.overview) lines.push(data.overview, "");

  if (data.decisions.length) {
    lines.push("## Decisions", "");
    for (const d of data.decisions) lines.push(`- ${d}`);
    lines.push("");
  }
  if (data.actionItems.length) {
    lines.push("## Action items", "");
    for (const a of data.actionItems) {
      lines.push(`- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ""}`);
    }
    lines.push("");
  }
  if (data.sections.length) {
    lines.push("## Sections", "");
    for (const s of data.sections) {
      lines.push(`### ${s.startSeconds != null ? `[${fmt(s.startSeconds)}] ` : ""}${s.title}`);
      for (const b of s.bullets) lines.push(`- ${b}`);
      lines.push("");
    }
  }
  if (data.topics.length) {
    lines.push("## Keywords", "", data.topics.join(", "), "");
  }
  if (data.transcript.length) {
    lines.push("## Transcript", "");
    for (const u of data.transcript) {
      const text = u.words.map((w) => w.text).join(" ").trim();
      const at = u.start != null ? ` [${fmt(u.start)}]` : "";
      lines.push(`**${u.speaker}**${at}: ${text}`, "");
    }
  }
  return lines.join("\n");
}

/**
 * Downloads the whole meeting (minutes + transcript) as a markdown file, and
 * offers a copy-to-clipboard. Pure client-side — no backend round-trip.
 */
function ExportControl({ data }: { data: MeetingDetailResponse }) {
  const [copied, setCopied] = useState(false);

  function download() {
    const md = buildMarkdown(data);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(
      data.title || data.summary?.split(/(?<=[.!?])\s/)[0] || "meeting",
    )}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Meeting exported");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildMarkdown(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={download}
        aria-label="Export meeting as markdown"
        title="Download as markdown"
        className="flex items-center gap-1.5 rounded-[5px] border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <DownloadIcon className="size-3.5" />
        export
      </button>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy meeting to clipboard"
        title="Copy as markdown"
        className="flex size-6 items-center justify-center rounded-[5px] border bg-background text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-(--thread-accent-primary)" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/* ── delete control (notebook header) ─────────────────────────────── */

/**
 * Owner-only Delete control in the notebook header. Confirms via AlertDialog,
 * deletes the meeting (record + durable video) through the deleteMeeting Server
 * Action, then routes back to the list and invalidates the cached index.
 */
function DeleteControl({ botId }: { botId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await deleteMeeting(botId);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Meeting deleted");
      qc.invalidateQueries({ queryKey: ["meetings"] });
      router.push("/meetings");
    },
    onError: (e) =>
      toast.error("Could not delete meeting", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Delete meeting"
        className="flex items-center gap-1.5 rounded-[5px] border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/60 hover:text-(--thread-accent-secondary)"
      >
        <Trash2Icon className="size-3.5" />
        delete
      </button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this meeting?</AlertDialogTitle>
          <AlertDialogDescription>
            The minutes, transcript and recording will be permanently deleted.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
            disabled={mutation.isPending}
            className="bg-(--thread-accent-secondary) text-white hover:bg-(--thread-accent-secondary)/90"
          >
            {mutation.isPending ? (
              <span className="flex items-center gap-1.5">
                <Loader2Icon className="size-3.5 animate-spin" />
                deleting…
              </span>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ── editable notebook title ───────────────────────────────────────── */

/**
 * Notebook title (header h1) with inline rename. Shows the owner title if set,
 * else the auto-derived fallback (summary/host). Clicking the pencil turns it
 * into an input; Enter/blur persists via updateMeetingTitle and refetches.
 * Escape cancels.
 */
function TitleControl({
  botId,
  title,
  fallback,
  onEdited,
}: {
  botId: string;
  title: string | null;
  fallback: string;
  onEdited: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await updateMeetingTitle(botId, draft);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Title updated");
      setEditing(false);
      onEdited();
    },
    onError: (e) =>
      toast.error("Could not save title", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => mutation.mutate()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            mutation.mutate();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        disabled={mutation.isPending}
        placeholder={fallback}
        aria-label="Meeting title"
        className="max-w-md rounded-[4px] border bg-background px-1.5 py-0.5 text-sm font-semibold tracking-tight outline-none focus-visible:border-(--thread-accent-primary)"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(title ?? "");
        setEditing(true);
      }}
      aria-label="Rename meeting"
      title="Rename meeting"
      className="group/title flex max-w-md items-center gap-1.5"
    >
      <span className="truncate text-sm font-semibold tracking-tight">
        {title?.trim() || fallback}
      </span>
      <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-70" />
    </button>
  );
}

/* ── editable summary panel ───────────────────────────────────────── */

/**
 * Summary + overview panel with an owner inline edit. Shows the generated text;
 * the pencil swaps to two textareas. Persists via updateMeetingSummary and
 * refetches. When empty (no summary AND not editing) the panel is hidden.
 */
function SummaryPanel({
  botId,
  summary,
  overview,
  onEdited,
}: {
  botId: string;
  summary: string | null;
  overview: string | null;
  onEdited: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftSummary, setDraftSummary] = useState(summary ?? "");
  const [draftOverview, setDraftOverview] = useState(overview ?? "");
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await updateMeetingSummary(botId, draftSummary, draftOverview);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Summary updated");
      setEditing(false);
      onEdited();
    },
    onError: (e) =>
      toast.error("Could not save summary", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  function startEdit() {
    setDraftSummary(summary ?? "");
    setDraftOverview(overview ?? "");
    setEditing(true);
  }

  if (!summary && !editing) {
    return (
      <Panel icon={SparklesIcon} label="ai / summary" action={<EditButton onClick={startEdit} label="Add summary" icon={PlusIcon} />}>
        <p className="text-sm italic text-muted-foreground">No summary yet.</p>
      </Panel>
    );
  }

  return (
    <Panel
      icon={SparklesIcon}
      label="ai / summary"
      tone={editing ? "default" : "success"}
      action={
        editing ? undefined : <EditButton onClick={startEdit} label="Edit summary" />
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            rows={3}
            placeholder="Executive summary…"
            aria-label="Summary"
            className="w-full resize-y rounded-[5px] border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-(--thread-accent-primary) focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary-soft)"
          />
          <textarea
            value={draftOverview}
            onChange={(e) => setDraftOverview(e.target.value)}
            rows={3}
            placeholder="Longer overview (optional)…"
            aria-label="Overview"
            className="w-full resize-y rounded-[5px] border bg-background px-2 py-1.5 text-sm text-muted-foreground outline-none focus-visible:border-(--thread-accent-primary) focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary-soft)"
          />
          <EditFooter
            busy={mutation.isPending}
            onSave={() => mutation.mutate()}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <p className="text-sm leading-relaxed">{summary}</p>
          {overview && (
            <p className="mt-2 border-t border-dashed border-border pt-2 text-sm leading-relaxed text-muted-foreground">
              {overview}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/* ── editable action items panel ──────────────────────────────────── */

/**
 * Action-items panel with full owner editing: add, edit task, (re)assign owner,
 * remove. The generated list is the initial draft; Save persists the whole set
 * via updateMeetingActionItems (blank tasks are dropped server-side). Hidden
 * when empty and not editing.
 */
function ActionItemsPanel({
  botId,
  items,
  onEdited,
}: {
  botId: string;
  items: MeetingActionItem[];
  onEdited: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MeetingActionItem[]>(items);
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await updateMeetingActionItems(botId, draft);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Action items updated");
      setEditing(false);
      onEdited();
    },
    onError: (e) =>
      toast.error("Could not save action items", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  function startEdit() {
    setDraft(items.length ? items : [{ task: "", owner: null }]);
    setEditing(true);
  }
  function setItem(i: number, patch: Partial<MeetingActionItem>) {
    setDraft((d) => d.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setDraft((d) => [...d, { task: "", owner: null }]);
  }
  function removeItem(i: number) {
    setDraft((d) => d.filter((_, j) => j !== i));
  }

  if (items.length === 0 && !editing) {
    return (
      <Panel
        icon={ListChecksIcon}
        label="ai / action items"
        action={<EditButton onClick={startEdit} label="Add action item" icon={PlusIcon} />}
      >
        <p className="text-sm italic text-muted-foreground">No action items.</p>
      </Panel>
    );
  }

  return (
    <Panel
      icon={ListChecksIcon}
      label="ai / action items"
      action={
        editing ? undefined : <EditButton onClick={startEdit} label="Edit action items" />
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          {draft.map((it, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={it.task}
                onChange={(e) => setItem(i, { task: e.target.value })}
                placeholder="Task…"
                aria-label={`Task ${i + 1}`}
                className="min-w-0 flex-1 rounded-[5px] border bg-background px-2 py-1 text-sm outline-none focus-visible:border-(--thread-accent-primary)"
              />
              <input
                value={it.owner ?? ""}
                onChange={(e) => setItem(i, { owner: e.target.value || null })}
                placeholder="Owner"
                aria-label={`Owner ${i + 1}`}
                className="w-20 shrink-0 rounded-[5px] border bg-background px-2 py-1 font-mono text-[11px] outline-none focus-visible:border-(--thread-accent-primary)"
              />
              <button
                type="button"
                onClick={() => removeItem(i)}
                aria-label="Remove action item"
                className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:text-(--thread-accent-secondary)"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addItem}
            className="flex items-center gap-1.5 self-start rounded-[5px] border border-dashed bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            <PlusIcon className="size-3" />
            add item
          </button>
          <EditFooter
            busy={mutation.isPending}
            onSave={() => mutation.mutate()}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((a, i) => (
            <li
              key={i}
              className="flex items-start justify-between gap-3 rounded-[5px] border bg-background px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 text-sm">{a.task}</span>
              {a.owner && (
                <span className="shrink-0 rounded-[4px] bg-(--thread-accent-primary-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--thread-accent-primary)">
                  {a.owner}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ── edit primitives (pencil trigger + save/cancel footer) ────────── */

function EditButton({
  onClick,
  label,
  icon: Icon = PencilIcon,
}: {
  onClick: () => void;
  label: string;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function EditFooter({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5 pt-1">
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="rounded-[5px] border bg-background px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        cancel
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-[5px] border border-(--thread-accent-primary)/40 bg-(--thread-accent-primary-soft) px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-(--thread-accent-primary) transition-colors hover:bg-(--thread-accent-primary-soft)/80 disabled:opacity-50"
      >
        {busy && <Loader2Icon className="size-3 animate-spin" />}
        save
      </button>
    </div>
  );
}

/* ── speaker legend (renamable) ───────────────────────────────────── */

/**
 * Speaker legend with inline rename. Clicking a name (or its pencil) turns it
 * into an input; Enter/blur persists via renameMeetingSpeaker, which rewrites
 * the label across the transcript, talk-shares and dynamics server-side, then
 * refetches. Escape cancels.
 */
function SpeakerLegend({
  botId,
  speakers,
  onRenamed,
}: {
  botId: string;
  speakers: string[];
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const mutation = useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      const res = await renameMeetingSpeaker(botId, from, to);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Speaker renamed");
      setEditing(null);
      onRenamed();
    },
    onError: (e) =>
      toast.error("Could not rename speaker", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  function commit(from: string) {
    const to = draft.trim();
    if (!to || to === from) {
      setEditing(null);
      return;
    }
    mutation.mutate({ from, to });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-dashed border-border px-3 py-2">
      {speakers.map((name, i) => {
        const isEditing = editing === name;
        return (
          <span
            key={name}
            className="group/spk flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-2 rounded-[1px]"
              style={{ background: speakerColor(i) }}
            />
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit(name);
                  } else if (e.key === "Escape") {
                    setEditing(null);
                  }
                }}
                disabled={mutation.isPending}
                aria-label={`Rename ${name}`}
                className="w-24 rounded-[3px] border bg-background px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider outline-none focus-visible:border-(--thread-accent-primary)"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(name);
                  setEditing(name);
                }}
                aria-label={`Rename ${name}`}
                title={`Rename ${name}`}
                className="flex items-center gap-1 hover:text-foreground"
              >
                {name}
                <PencilIcon className="size-2.5 opacity-0 transition-opacity group-hover/spk:opacity-60" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/* ── video (real mp4) ─────────────────────────────────────────────── */

function VideoPanel({
  videoUrl,
  transcriptState,
  videoRef,
  onTime,
}: {
  videoUrl: string | null;
  transcriptState: MeetingDetailResponse["transcriptState"];
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTime: (t: number) => void;
}) {
  if (!videoUrl) {
    return (
      <div className="flex aspect-video max-h-56 w-full items-center justify-center rounded-[5px] border bg-black/90 font-mono text-[11px] uppercase tracking-wider text-white/60">
        {transcriptState === "processing"
          ? "recording still processing…"
          : "no video for this meeting"}
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      src={videoUrl}
      controls
      className="aspect-video max-h-56 w-full rounded-[5px] border bg-black"
      onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
    />
  );
}

/* ── transcript (karaoke) ─────────────────────────────────────────── */

function TranscriptPanel({
  data,
  currentTime,
  speakerIndex,
  onSeek,
  query,
  onQueryChange,
}: {
  data: MeetingDetailResponse;
  currentTime: number;
  speakerIndex: Map<string, number>;
  onSeek: (s: number | null) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const q = query.trim().toLowerCase();

  // Filter utterances to those containing the query (search within transcript).
  const utterances = useMemo(() => {
    if (!q) return data.transcript;
    return data.transcript.filter((utt) =>
      utt.words.some((w) => w.text.toLowerCase().includes(q)),
    );
  }, [data.transcript, q]);

  if (data.transcript.length === 0) {
    return (
      <div className="mt-1 flex min-h-0 flex-1 items-center justify-center rounded-[5px] border bg-background px-3 text-center font-mono text-[11px] text-muted-foreground">
        {data.transcriptState === "processing"
          ? "transcript processing — appears here once ready"
          : "no transcript for this meeting"}
      </div>
    );
  }

  return (
    <div className="mt-1 flex min-h-0 flex-1 flex-col rounded-[5px] border bg-background">
      {/* transcript search */}
      <label className="flex items-center gap-1.5 border-b border-dashed border-border px-3 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="search transcript…"
          aria-label="Search transcript"
          className="w-full bg-transparent font-mono text-[11px] outline-none placeholder:text-muted-foreground/70"
        />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {utterances.length === 0 ? (
          <div className="flex items-center justify-center px-3 py-8 text-center font-mono text-[11px] text-muted-foreground">
            no lines match “{query}”
          </div>
        ) : (
          utterances.map((utt, i) => {
            const idx = speakerIndex.get(utt.speaker) ?? 0;
            const color = speakerColor(idx);
            return (
              <div
                key={i}
                // content-visibility: transcript de call de 1h+ gera milhares de
                // nós (utterance × words). Pula layout/paint das utterances fora
                // da viewport; contain-intrinsic-size reserva altura estimada.
                className="flex gap-3 border-l-2 border-l-transparent px-3 py-2.5 [contain-intrinsic-size:auto_72px] [content-visibility:auto]"
              >
                <span
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[5px] font-mono text-[10px] font-semibold text-background"
                  style={{ background: color }}
                >
                  {initials(utt.speaker)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-medium">
                      {utt.speaker}
                    </span>
                    {utt.start != null && (
                      <button
                        type="button"
                        onClick={() => onSeek(utt.start)}
                        className="font-mono text-[10px] tabular-nums hover:underline"
                        style={{ color }}
                      >
                        {fmt(utt.start)}
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm leading-relaxed">
                    {utt.words.map((w, j) => {
                      const active =
                        w.start != null &&
                        w.end != null &&
                        currentTime >= w.start &&
                        currentTime < w.end;
                      const matches = q && w.text.toLowerCase().includes(q);
                      // Each word is keyboard-operable: role=button + tabIndex +
                      // Enter/Space seek the player (not just mouse click).
                      return (
                        <span
                          key={j}
                          role="button"
                          tabIndex={0}
                          onClick={() => onSeek(w.start)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSeek(w.start);
                            }
                          }}
                          className={cn(
                            "cursor-pointer rounded outline-none focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary)",
                            active
                              ? "bg-(--thread-accent-primary-soft) font-medium text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                            matches && !active &&
                              "bg-[oklch(0.7_0.15_70)]/25 text-foreground",
                          )}
                        >
                          {w.text}{" "}
                        </span>
                      );
                    })}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ── AI panels ────────────────────────────────────────────────────── */

function NotesPanels({
  data,
  onSeek,
  clip,
  onEdited,
}: {
  data: MeetingDetailResponse;
  onSeek: (s: number | null) => void;
  clip: ReturnType<typeof useClip>;
  /** Refetches the meeting detail after an owner edit persists. */
  onEdited: () => void;
}) {
  const sortedShares = useMemo(
    () => [...data.talkShares].sort((a, b) => b.share - a.share),
    [data.talkShares],
  );

  const canClip = Boolean(data.videoUrl);

  return (
    <>
      <SummaryPanel
        botId={data.botId}
        summary={data.summary}
        overview={data.overview}
        onEdited={onEdited}
      />

      {data.moments.length > 0 && (
        <Panel icon={BookmarkIcon} label="ai / key moments">
          <div className="flex flex-col gap-1.5">
            {data.moments.map((m, i) => {
              const Icon = MOMENT_ICON[m.kind];
              const id = `moment-${i}`;
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-[5px] border bg-background pr-1 transition-colors hover:bg-muted/40"
                >
                  <button
                    type="button"
                    onClick={() => onSeek(m.atSeconds)}
                    disabled={m.atSeconds == null}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-default"
                  >
                    <Icon
                      className={cn("size-3.5 shrink-0", momentColor(m.kind))}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {m.label}
                    </span>
                    {m.atSeconds != null && (
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {fmt(m.atSeconds)}
                      </span>
                    )}
                  </button>
                  {canClip && m.atSeconds != null && (
                    <ClipButton
                      id={id}
                      clip={clip}
                      videoUrl={data.videoUrl!}
                      // ~16s window centered a bit before the moment.
                      start={Math.max(0, m.atSeconds - 4)}
                      end={m.atSeconds + 12}
                      filename={`clip-${slug(m.label)}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {data.soundbites.length > 0 && (
        <Panel icon={ScissorsIcon} label="ai / soundbites" tone="success">
          <div className="flex flex-col gap-1.5">
            {data.soundbites.map((sb, i) => (
              <SoundbiteRow
                key={i}
                id={`soundbite-${i}`}
                sb={sb}
                clip={clip}
                videoUrl={canClip ? data.videoUrl : null}
                onSeek={onSeek}
              />
            ))}
          </div>
        </Panel>
      )}

      {data.sections.length > 0 && (
        <Panel icon={FileTextIcon} label="ai / sections">
          <div className="flex flex-col gap-3">
            {data.sections.map((s, i) => (
              <div key={i}>
                <button
                  type="button"
                  onClick={() => onSeek(s.startSeconds)}
                  className="flex items-center gap-2 text-sm font-medium hover:underline"
                >
                  {s.startSeconds != null && (
                    <span className="font-mono text-[10px] tabular-nums text-(--thread-accent-primary)">
                      {fmt(s.startSeconds)}
                    </span>
                  )}
                  {s.title}
                </button>
                <ul className="ml-3 mt-1 flex flex-col gap-1">
                  {s.bullets.map((b, j) => (
                    <li
                      key={j}
                      className="flex gap-2 text-sm leading-relaxed text-muted-foreground"
                    >
                      <span
                        aria-hidden
                        className="mt-2 size-1 shrink-0 rounded-[1px] bg-muted-foreground/50"
                      />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {data.decisions.length > 0 && (
        <Panel icon={CheckIcon} label="ai / decisions">
          <ul className="flex flex-col gap-1.5">
            {data.decisions.map((d, i) => (
              <li
                key={i}
                className="flex items-start gap-2 rounded-[5px] border bg-background px-2.5 py-1.5 text-sm"
              >
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-(--thread-accent-primary)" />
                <span className="min-w-0">{d}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <ActionItemsPanel
        botId={data.botId}
        items={data.actionItems}
        onEdited={onEdited}
      />

      {data.topics.length > 0 && (
        <Panel icon={HashIcon} label="ai / keywords">
          <div className="flex flex-wrap gap-1.5">
            {data.topics.map((t) => (
              <span
                key={t}
                className="rounded-[5px] border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </Panel>
      )}

      {data.dynamics && (
        <DynamicsPanel
          botId={data.botId}
          dynamics={data.dynamics}
          insight={data.dynamicsInsight}
          videoUrl={canClip ? data.videoUrl : null}
          onSeek={onSeek}
        />
      )}

      {!!data.screenshareSpans?.length && canClip && data.videoUrl && (
        <ScreensPanel
          botId={data.botId}
          videoUrl={data.videoUrl}
          spans={data.screenshareSpans}
          transcript={data.transcript}
          tensionMoments={data.dynamics?.moments ?? []}
          onSeek={onSeek}
        />
      )}

      {sortedShares.length > 0 && (
        <Panel icon={UsersIcon} label="ai / talk time">
          <div className="flex flex-col gap-2">
            {sortedShares.map((p, i) => (
              <div key={i}>
                <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{p.name}</span>
                  <span className="tabular-nums">
                    {Math.round(p.share * 100)}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-(--thread-accent-primary)"
                    style={{ width: `${Math.round(p.share * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

/* ── team dynamics / meeting-health dashboard ───────────────────── */

const DYNAMICS_MOMENT_ICON: Record<
  MeetingDynamics["moments"][number]["kind"],
  LucideIcon
> = {
  interruption: ZapIcon,
  monologue: RadioIcon,
  silence: MicOffIcon,
};

/** Emotional tone → text color for an LLM-labeled moment. */
function toneColor(tone: MeetingHealthInsight["moments"][number]["tone"]): string {
  return {
    tense: "text-(--thread-accent-secondary)",
    energized: "text-[oklch(0.7_0.15_70)]",
    flat: "text-muted-foreground",
    neutral: "text-muted-foreground",
  }[tone];
}

function DynamicsPanel({
  botId,
  dynamics,
  insight,
  videoUrl,
  onSeek,
}: {
  botId: string;
  dynamics: MeetingDynamics;
  insight: MeetingHealthInsight | null;
  videoUrl: string | null;
  onSeek: (s: number | null) => void;
}) {
  const { participants, balance, interruptions, silenceSeconds, moments } =
    dynamics;
  const tension = useTensionAnalysis();
  const tenseByAt =
    tension.state.status === "done" ? tension.state.result.byAt : null;
  const behavior =
    tension.state.status === "done" ? tension.state.result.behavior : null;
  // LLM behavioral read per tense moment, matched by rounded second.
  const behaviorByAt = new Map(
    (behavior?.moments ?? []).map((m) => [Math.round(m.atSeconds), m]),
  );
  // Balance drives the headline read: even floor vs one-person-dominated.
  const balancePct = Math.round(balance * 100);
  const balanceLabel =
    balancePct >= 70 ? "balanced" : balancePct >= 40 ? "uneven" : "dominated";
  const balanceTone =
    balancePct >= 70
      ? "text-(--thread-accent-primary)"
      : balancePct >= 40
        ? "text-[oklch(0.7_0.15_70)]"
        : "text-(--thread-accent-secondary)";

  // Prefer the LLM's semantic read of each moment; fall back to the raw timing
  // label. Matched by rounded second (how the insight carries continuity).
  const insightByAt = new Map(
    (insight?.moments ?? []).map((m) => [Math.round(m.atSeconds), m]),
  );

  return (
    <Panel icon={ActivityIcon} label="ai / team dynamics" tone="success">
      <div className="flex flex-col gap-3">
        {/* LLM meeting-health read — the coaching layer over the raw metrics */}
        {insight && (
          <div>
            <p className="text-sm font-semibold leading-snug">
              {insight.headline}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {insight.summary}
            </p>
          </div>
        )}

        {/* headline stats */}
        <div
          className={cn(
            "grid grid-cols-3 gap-2",
            insight && "border-t border-dashed border-border pt-2",
          )}
        >
          <Stat
            label="balance"
            value={`${balancePct}%`}
            hint={balanceLabel}
            tone={balanceTone}
          />
          <Stat label="interruptions" value={String(interruptions)} />
          <Stat label="silence" value={`${Math.round(silenceSeconds)}s`} />
        </div>

        {/* per-participant behavior */}
        <div className="flex flex-col gap-2 border-t border-dashed border-border pt-2">
          {participants.map((p, i) => (
            <div key={i}>
              <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                <span className="truncate">{p.name}</span>
                <span className="tabular-nums">
                  {Math.round(p.talkShare * 100)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-(--thread-accent-primary)"
                  style={{ width: `${Math.round(p.talkShare * 100)}%` }}
                />
              </div>
              {(p.interruptionsMade > 0 || p.longestTurnSeconds >= 90) && (
                <div className="mt-0.5 flex gap-2 font-mono text-[10px] text-muted-foreground">
                  {p.interruptionsMade > 0 && (
                    <span>{p.interruptionsMade}× interrupted others</span>
                  )}
                  {p.longestTurnSeconds >= 90 && (
                    <span>
                      {Math.round(p.longestTurnSeconds)}s longest turn
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* human moments — jump to the tension/monologue/dead-air points */}
        {moments.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-dashed border-border pt-2">
            {/* on-demand acoustic tension analysis (prosody over the audio) */}
            {videoUrl && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  moments
                </span>
                <button
                  type="button"
                  onClick={() => tension.run(botId, videoUrl, dynamics)}
                  disabled={
                    tension.state.status === "analyzing" ||
                    tension.state.status === "reading"
                  }
                  className="flex items-center gap-1.5 rounded-[4px] border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-60"
                >
                  {tension.state.status === "analyzing" ? (
                    <>
                      <Loader2Icon className="size-3 animate-spin" />
                      {Math.round(tension.state.progress * 100)}%
                    </>
                  ) : tension.state.status === "reading" ? (
                    <>
                      <Loader2Icon className="size-3 animate-spin" />
                      reading
                    </>
                  ) : (
                    <>
                      <FlameIcon className="size-3" />
                      {tenseByAt ? "re-analyze" : "analyze tension"}
                    </>
                  )}
                </button>
              </div>
            )}
            {tension.state.status === "error" && (
              <p className="font-mono text-[10px] text-(--thread-accent-secondary)">
                {tension.state.message}
              </p>
            )}
            {/* LLM behavioral read over the acoustic tension — the "how it felt" */}
            {behavior && (
              <div className="rounded-[5px] border border-(--thread-accent-secondary)/40 bg-(--thread-accent-secondary)/5 px-2.5 py-2">
                <p className="flex items-center gap-1.5 text-sm font-semibold leading-snug text-(--thread-accent-secondary)">
                  <FlameIcon className="size-3.5 shrink-0" />
                  {behavior.headline}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {behavior.summary}
                </p>
              </div>
            )}
            {moments.map((m, i) => {
              const Icon = DYNAMICS_MOMENT_ICON[m.kind];
              const read = insightByAt.get(Math.round(m.atSeconds));
              const label = read?.label ?? m.label;
              const behave = behaviorByAt.get(Math.round(m.atSeconds));
              const tense = tenseByAt?.get(Math.round(m.atSeconds));
              const color = tense?.isTense
                ? "text-(--thread-accent-secondary)"
                : read
                  ? toneColor(read.tone)
                  : m.kind === "interruption"
                    ? "text-(--thread-accent-secondary)"
                    : m.kind === "monologue"
                      ? "text-[oklch(0.7_0.15_70)]"
                      : "text-muted-foreground";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSeek(m.atSeconds)}
                  className="flex flex-col gap-1 rounded-[5px] border bg-background px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex w-full items-center gap-2.5">
                    <Icon className={cn("size-3.5 shrink-0", color)} />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {label}
                    </span>
                    {tense?.isTense && (
                      <span className="flex shrink-0 items-center gap-1 rounded-[4px] bg-(--thread-accent-secondary)/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-(--thread-accent-secondary)">
                        <FlameIcon className="size-2.5" />
                        tense
                      </span>
                    )}
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {fmt(m.atSeconds)}
                    </span>
                  </div>
                  {/* LLM behavioral read of the tense moment (the "why") */}
                  {behave && (
                    <div className="flex items-start gap-1.5 pl-6">
                      <span className="shrink-0 rounded-[3px] bg-muted px-1 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                        {behave.behavior}
                      </span>
                      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                        {behave.read}
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Icon per capture trigger — why this screen was grabbed. */
const SCREEN_TRIGGER_ICON: Record<ScreenCapture["trigger"], LucideIcon> = {
  "screen-start": MonitorIcon,
  "screen-change": ImageIcon,
  deixis: HashIcon,
  tension: FlameIcon,
};

function ScreensPanel({
  botId,
  videoUrl,
  spans,
  transcript,
  tensionMoments,
  onSeek,
}: {
  botId: string;
  videoUrl: string;
  spans: ScreenshareSpan[];
  transcript: TranscriptUtterance[];
  tensionMoments: Array<{ atSeconds: number }>;
  onSeek: (s: number | null) => void;
}) {
  const screens = useScreenIntelligence();
  const insight =
    screens.state.status === "done" ? screens.state.insight : null;
  const busy =
    screens.state.status === "capturing" || screens.state.status === "reading";

  // Total shared time, for the header stat.
  const sharedSeconds = spans.reduce(
    (a, s) => a + (s.end != null ? s.end - s.start : 0),
    0,
  );

  return (
    <Panel icon={MonitorIcon} label="ai / screens" tone="success">
      <div className="flex flex-col gap-3">
        {/* headline + run control */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-snug">
              {insight?.headline ?? "Screen sharing detected"}
            </p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {spans.length} share{spans.length === 1 ? "" : "s"}
              {sharedSeconds > 0 && ` · ${Math.round(sharedSeconds)}s`}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              screens.run({
                botId,
                videoUrl,
                spans,
                transcript,
                tensionMoments,
              })
            }
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 rounded-[4px] border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-60"
          >
            {screens.state.status === "capturing" ? (
              <>
                <Loader2Icon className="size-3 animate-spin" />
                {Math.round(screens.state.progress * 100)}%
              </>
            ) : screens.state.status === "reading" ? (
              <>
                <Loader2Icon className="size-3 animate-spin" />
                reading
              </>
            ) : (
              <>
                <ImageIcon className="size-3" />
                {insight ? "re-analyze" : "analyze screens"}
              </>
            )}
          </button>
        </div>

        {screens.state.status === "error" && (
          <p className="font-mono text-[10px] text-(--thread-accent-secondary)">
            {screens.state.message}
          </p>
        )}

        {screens.state.status === "done" && !insight && (
          <p className="font-mono text-[10px] text-muted-foreground">
            No readable screens found.
          </p>
        )}

        {/* captured screens — jump to the moment in the player */}
        {insight && insight.captures.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-dashed border-border pt-2">
            {insight.captures.map((c, i) => {
              const Icon = SCREEN_TRIGGER_ICON[c.trigger];
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSeek(c.atSeconds)}
                  className="flex flex-col gap-1 rounded-[5px] border bg-background px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex w-full items-center gap-2.5">
                    <Icon className="size-3.5 shrink-0 text-(--thread-accent-primary)" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {c.title}
                    </span>
                    <span className="shrink-0 rounded-[3px] bg-muted px-1 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      {c.kind}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {fmt(c.atSeconds)}
                    </span>
                  </div>
                  {c.details && (
                    <span className="whitespace-pre-line pl-6 text-[11px] leading-snug text-muted-foreground">
                      {c.details}
                    </span>
                  )}
                  {c.discussed && (
                    <span className="pl-6 font-mono text-[9px] uppercase tracking-wider text-(--thread-accent-primary)">
                      discussed on call
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-[5px] border bg-background px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", tone)}>
        {value}
      </div>
      {hint && (
        <div className="font-mono text-[9px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function momentColor(kind: MeetingMoment["kind"]): string {
  return {
    topic: "text-(--thread-accent-primary)",
    action: "text-(--thread-accent-primary)",
    question: "text-[oklch(0.7_0.15_70)]",
    objection: "text-(--thread-accent-secondary)",
  }[kind];
}

/* ── soundbite row (curated highlight + exact-range clip) ────────── */

function SoundbiteRow({
  id,
  sb,
  clip,
  videoUrl,
  onSeek,
}: {
  id: string;
  sb: MeetingSoundbite;
  clip: ReturnType<typeof useClip>;
  videoUrl: string | null;
  onSeek: (s: number | null) => void;
}) {
  const dur = Math.round(sb.endSeconds - sb.startSeconds);
  return (
    <div className="flex items-center gap-2 rounded-[5px] border bg-background pr-1 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={() => onSeek(sb.startSeconds)}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <QuoteIcon className="size-3.5 shrink-0 text-(--thread-accent-primary)" />
        <span className="min-w-0 flex-1 truncate text-sm">{sb.label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmt(sb.startSeconds)} · {dur}s
        </span>
      </button>
      {videoUrl && (
        <ClipButton
          id={id}
          clip={clip}
          videoUrl={videoUrl}
          noun="soundbite"
          // Exact curated range — no heuristic window.
          start={sb.startSeconds}
          end={sb.endSeconds}
          filename={`soundbite-${slug(sb.label)}`}
        />
      )}
    </div>
  );
}

/* ── clip button (mediabunny soundbite) ──────────────────────────── */

function ClipButton({
  id,
  clip,
  videoUrl,
  start,
  end,
  filename,
  noun = "moment",
}: {
  id: string;
  clip: ReturnType<typeof useClip>;
  videoUrl: string;
  start: number;
  end: number;
  filename: string;
  /** What is being clipped, for the aria-label (e.g. "moment", "soundbite"). */
  noun?: string;
}) {
  const busy = clip.state.status === "clipping" && clip.state.id === id;
  const failed = clip.state.status === "error" && clip.state.id === id;
  const pct = busy ? Math.round((clip.state as ClipStateClipping).progress * 100) : 0;

  return (
    <button
      type="button"
      aria-label={failed ? `Clip failed — retry ${noun}` : `Clip this ${noun}`}
      title={failed ? "Clip failed — click to retry" : "Clip to mp4"}
      onClick={() => clip.run({ id, videoUrl, start, end, filename })}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[5px] font-mono text-[9px] tabular-nums transition-colors",
        failed
          ? "text-(--thread-accent-secondary) hover:bg-muted/60"
          : "text-muted-foreground hover:bg-muted/60 hover:text-(--thread-accent-primary)",
      )}
    >
      {busy ? (
        <span className="tabular-nums">{pct}</span>
      ) : (
        <ScissorsIcon className="size-3.5" />
      )}
    </button>
  );
}

/** Narrowing helper: the clipping variant of ClipState. */
type ClipStateClipping = Extract<ClipState, { status: "clipping" }>;

/* ── visual primitives (casadas com ToolCard/Row do assistant) ────── */

function Meta({ icon: Icon, v }: { icon: LucideIcon; v: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Icon className="size-3" />
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
    <span className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}

function Panel({
  icon: Icon,
  label,
  tone = "default",
  action,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone?: "default" | "success";
  /** Optional control on the right of the header (e.g. an edit pencil). */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          {tone === "success" && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
              <span
                aria-hidden
                className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
              />
              generated
            </span>
          )}
          {action}
        </span>
      </div>
      <div className="rounded-[5px] border bg-background p-3">{children}</div>
    </div>
  );
}
