"use client";

/**
 * Meetings index (real data). Dense inbox-style rows — one meeting per line:
 * status dot + derived title + meta + participant count. Rows whose minutes are
 * "done" link to the notebook (/meetings/[botId]).
 *
 * Identity: EvilCharts/terminal — mono uppercase header, oklch accents, pulse
 * dots, discreet borders. Data comes from meeting_records via useMeetingsList;
 * the DB has no meeting title, so we derive a readable label from the summary
 * or the meeting URL host.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SearchIcon,
  CircleDotIcon,
  LoaderIcon,
  CalendarIcon,
  ClockIcon,
  AlertTriangleIcon,
  RotateCwIcon,
  XIcon,
  Trash2Icon,
  Loader2Icon,
  PlusIcon,
  VideoIcon,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import {
  useMeetingsList,
  type MeetingListItem,
  type MeetingStatus,
  type MeetingsQuery,
} from "@/features/meetings/model/queries";
import {
  reprocessMeeting,
  cancelScheduledMeeting,
  deleteMeeting,
  scheduleMeetingBot,
} from "@/features/meetings/api/actions";

/** Debounces a value so we don't fire a server search on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Status filters offered in the list header (subset users care to filter by). */
const STATUS_FILTERS: Array<{ value: MeetingsQuery["status"]; label: string }> = [
  { value: undefined, label: "all" },
  { value: "done", label: "transcribed" },
  { value: "processing", label: "processing" },
  { value: "failed", label: "failed" },
];

/* ── helpers ──────────────────────────────────────────────────────── */

/** Owner title if set, else the summary's first sentence, else the URL host. */
function deriveTitle(m: MeetingListItem): string {
  const t = m.title?.trim();
  if (t) return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  const s = m.summary?.trim();
  if (s) {
    const firstSentence = s.split(/(?<=[.!?])\s/)[0] ?? s;
    return firstSentence.length > 80
      ? `${firstSentence.slice(0, 77)}…`
      : firstSentence;
  }
  if (m.meetingUrl) {
    try {
      return `Meeting · ${new URL(m.meetingUrl).host}`;
    } catch {
      /* fall through */
    }
  }
  return "Untitled meeting";
}

/** "12m" / "1h 05m" compact duration from seconds. Null-safe. */
function fmtDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** "Today · 14:00" style label, computed on the client from createdAt. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const day = sameDay
    ? "Today"
    : isYesterday
      ? "Yesterday"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} · ${time}`;
}

/* ── page ─────────────────────────────────────────────────────────── */

export function MeetingsList() {
  const [rawQuery, setRawQuery] = useState("");
  const [status, setStatus] = useState<MeetingsQuery["status"]>(undefined);
  // Server-side search: debounce the keystrokes into a stable query key.
  const q = useDebounced(rawQuery.trim(), 300);

  const {
    flat: meetings,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMeetingsList({ q: q || undefined, status });

  // Infinite scroll: load the next page when the sentinel enters the viewport.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const filtering = Boolean(q) || Boolean(status);

  return (
    <main className="flex h-dvh w-full justify-start overflow-hidden bg-(--thread-frame-outer) font-sans text-foreground">
      <div className="flex min-h-0 w-full max-w-2xl flex-col px-2 sm:px-6 lg:px-10">
        {/* ── header (sticky so filters stay reachable while the list scrolls) ── */}
        <header className="sticky top-0 z-10 flex shrink-0 flex-col gap-3 border-b border-border/60 bg-(--thread-frame-outer)/80 px-4 py-4 backdrop-blur-sm sm:px-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-7 items-center justify-center rounded-[6px] border bg-background font-mono text-xs font-semibold text-(--thread-accent-primary)">
                C
              </span>
              <div className="flex flex-col">
                <h1 className="text-sm font-semibold tracking-tight">
                  Meetings
                </h1>
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
                  />
                  {isLoading ? "loading" : `${meetings.length}`} · recall.ai
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 rounded-[6px] border bg-background px-2.5 py-1.5 transition-colors focus-within:border-(--thread-accent-primary) focus-within:ring-1 focus-within:ring-(--thread-accent-primary-soft)">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  value={rawQuery}
                  onChange={(e) => setRawQuery(e.target.value)}
                  placeholder="search meetings…"
                  aria-label="Search meetings"
                  className="w-32 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/70 sm:w-44"
                />
              </label>
              <NewMeetingButton />
            </div>
          </div>

          {/* status filter chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {STATUS_FILTERS.map((f) => {
              const active = status === f.value;
              return (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => setStatus(f.value)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-[5px] border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary)",
                    active
                      ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                      : "border-border bg-background text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </header>

        {/* ── list (dense rows) ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4 sm:px-5">
          <div className="overflow-hidden rounded-[8px] border bg-background shadow-sm">
            {error ? (
              <EmptyState
                icon={AlertTriangleIcon}
                text="Could not load meetings."
              />
            ) : isLoading ? (
              <MeetingRowSkeletons />
            ) : meetings.length === 0 ? (
              <EmptyState
                icon={CalendarIcon}
                text={
                  filtering
                    ? "no meetings match your filters"
                    : "no meetings yet — ask the agent to send a bot to a call"
                }
              />
            ) : (
              meetings.map((m, i) => (
                <MeetingRow key={m.botId} m={m} first={i === 0} />
              ))
            )}
          </div>

          {/* infinite-scroll sentinel + loader */}
          {hasNextPage && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              {isFetchingNextPage ? "loading more…" : ""}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/* ── row ──────────────────────────────────────────────────────────── */

function MeetingRow({ m, first }: { m: MeetingListItem; first: boolean }) {
  const clickable = m.status === "done";
  const title = deriveTitle(m);
  const duration = fmtDuration(m.durationSeconds);

  const inner = (
    <div
      className={cn(
        // content-visibility: pula layout/paint das rows fora da viewport na
        // lista infinite-scroll (só cresce). contain-intrinsic-size reserva a
        // altura estimada da row p/ o scrollbar não pular. Mesmo padrão do
        // thread.tsx. ~66px (py-3 + 2 linhas).
        "group flex items-center gap-3 px-4 py-3 transition-colors duration-150 [contain-intrinsic-size:auto_66px] [content-visibility:auto]",
        !first && "border-t border-border",
        clickable && "cursor-pointer hover:bg-muted/40",
      )}
    >
      <StatusDot status={m.status} />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-sm font-medium transition-colors",
            clickable && "group-hover:text-(--thread-accent-primary)",
          )}
        >
          {title}
        </span>
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="tabular-nums">{fmtWhen(m.createdAt)}</span>
          {duration && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <ClockIcon className="size-3" aria-hidden />
                {duration}
              </span>
            </>
          )}
          {m.participantCount > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {m.participantCount}{" "}
                {m.participantCount === 1 ? "speaker" : "speakers"}
              </span>
            </>
          )}
          <StatusLabel status={m.status} />
        </div>
      </div>

      {/* recovery actions for failed / scheduled rows */}
      <RowAction m={m} />

      {/* delete — available on every row */}
      <DeleteAction m={m} title={title} />

      {m.participantCount > 0 && (
        <span className="shrink-0 rounded-[5px] border bg-background px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          {m.participantCount}
        </span>
      )}
    </div>
  );

  if (!clickable) return inner;
  return (
    <Link
      href={`/meetings/${m.botId}`}
      aria-label={`Open notebook: ${title}`}
      className="block focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--thread-accent-primary)"
    >
      {inner}
    </Link>
  );
}

/* ── recovery actions (failed → reprocess, scheduled → cancel) ─────── */

function RowAction({ m }: { m: MeetingListItem }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const res =
        m.status === "failed"
          ? await reprocessMeeting(m.botId)
          : await cancelScheduledMeeting(m.botId);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () =>
      toast.success(
        m.status === "failed" ? "Meeting requeued" : "Scheduled meeting cancelled",
      ),
    onError: (e) =>
      toast.error(
        m.status === "failed" ? "Could not reprocess" : "Could not cancel",
        { description: e instanceof Error ? e.message : undefined },
      ),
    // Refresh the list so the row reflects its new state (requeued/removed).
    onSettled: () => qc.invalidateQueries({ queryKey: ["meetings"] }),
  });

  if (m.status !== "failed" && m.status !== "scheduled") return null;

  const isFailed = m.status === "failed";
  const Icon = isFailed ? RotateCwIcon : XIcon;
  const label = isFailed ? "Reprocess meeting" : "Cancel scheduled meeting";

  return (
    <button
      type="button"
      aria-label={label}
      title={mutation.isError ? `Failed — ${mutation.error?.message}` : label}
      disabled={mutation.isPending}
      // Stop the click from bubbling to a wrapping Link (there is none for these
      // statuses today, but keep it robust if that changes).
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        mutation.mutate();
      }}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[5px] border bg-background transition-colors hover:bg-muted/60 disabled:opacity-50",
        mutation.isError
          ? "text-(--thread-accent-secondary)"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon
        className={cn("size-3.5", mutation.isPending && "animate-spin")}
      />
    </button>
  );
}

/* ── new meeting (send a bot: now or scheduled) ───────────────────── */

function NewMeetingButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [joinAt, setJoinAt] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await scheduleMeetingBot({
        meetingUrl: url,
        joinAt: mode === "schedule" ? joinAt : null,
      });
      if (!res.ok) throw new Error(res.error);
      return res;
    },
    onSuccess: (res) => {
      toast.success(res.scheduled ? "Bot scheduled" : "Bot joining now", {
        description: res.reused ? "Reused an existing bot for this meeting." : undefined,
      });
      qc.invalidateQueries({ queryKey: ["meetings"] });
      setOpen(false);
      setUrl("");
      setJoinAt("");
      setMode("now");
    },
    onError: (e) =>
      toast.error("Could not send bot", {
        description: e instanceof Error ? e.message : undefined,
      }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="New meeting"
        className="flex items-center gap-1.5 rounded-[6px] border border-(--thread-accent-primary)/40 bg-(--thread-accent-primary-soft) px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-(--thread-accent-primary) transition-colors hover:bg-(--thread-accent-primary-soft)/80"
      >
        <PlusIcon className="size-3.5" />
        <span className="hidden sm:inline">new</span>
      </button>

      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <VideoIcon className="size-4 text-(--thread-accent-primary)" />
            Send a bot to a meeting
          </DialogTitle>
          <DialogDescription>
            Paste a Zoom / Google Meet / Teams link. The bot joins and records
            automatically — join now, or schedule it ahead.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="flex flex-col gap-3"
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://meet.google.com/…"
            aria-label="Meeting URL"
            autoFocus
            className="w-full rounded-[6px] border bg-background px-3 py-2 font-mono text-[13px] outline-none focus-visible:border-(--thread-accent-primary) focus-visible:ring-1 focus-visible:ring-(--thread-accent-primary-soft)"
          />

          {/* now vs schedule */}
          <div className="flex gap-1.5">
            {(["now", "schedule"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cn(
                  "flex-1 rounded-[5px] border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                  mode === m
                    ? "border-(--thread-accent-primary) bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "now" ? "join now" : "schedule"}
              </button>
            ))}
          </div>

          {mode === "schedule" && (
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                join at (must be &gt;10min ahead)
              </span>
              <input
                type="datetime-local"
                value={joinAt}
                onChange={(e) => setJoinAt(e.target.value)}
                aria-label="Join time"
                className="w-full rounded-[6px] border bg-background px-3 py-2 font-mono text-[13px] outline-none focus-visible:border-(--thread-accent-primary)"
              />
            </label>
          )}

          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
              className="rounded-[6px] border bg-background px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              cancel
            </button>
            <button
              type="submit"
              aria-label="Send bot"
              disabled={
                mutation.isPending ||
                !url.trim() ||
                (mode === "schedule" && !joinAt)
              }
              className="flex items-center gap-1.5 rounded-[6px] border border-(--thread-accent-primary)/40 bg-(--thread-accent-primary-soft) px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-(--thread-accent-primary) transition-colors hover:bg-(--thread-accent-primary-soft)/80 disabled:opacity-50"
            >
              {mutation.isPending && <Loader2Icon className="size-3.5 animate-spin" />}
              {mode === "now" ? "join now" : "schedule"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ── delete (every row, confirm dialog) ───────────────────────────── */

function DeleteAction({ m, title }: { m: MeetingListItem; title: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await deleteMeeting(m.botId);
      if (!res.ok) throw new Error(res.error);
    },
    onSuccess: () => {
      toast.success("Meeting deleted");
      setOpen(false);
    },
    onError: (e) =>
      toast.error("Could not delete meeting", {
        description: e instanceof Error ? e.message : undefined,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meetings"] }),
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        aria-label="Delete meeting"
        title="Delete meeting"
        // Stop the click from bubbling to the row's wrapping Link.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-[5px] border bg-background text-muted-foreground opacity-0 transition-colors hover:bg-muted/60 hover:text-(--thread-accent-secondary) focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2Icon className="size-3.5" />
      </button>

      <AlertDialogContent
        // Keep clicks inside the dialog from reaching the row Link underneath.
        onClick={(e) => e.stopPropagation()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this meeting?</AlertDialogTitle>
          <AlertDialogDescription>
            “{title}” — its minutes, transcript and recording will be permanently
            deleted. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            // Don't auto-close: keep the dialog open until the delete resolves.
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

/* ── primitives ───────────────────────────────────────────────────── */

function StatusDot({ status }: { status: MeetingStatus }) {
  if (status === "scheduled") {
    return (
      <ClockIcon className="size-3.5 shrink-0 text-[oklch(0.7_0.15_70)]" />
    );
  }
  if (status === "processing" || status === "pending") {
    return (
      <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground [animation-duration:0.8s]" />
    );
  }
  if (status === "failed") {
    return (
      <AlertTriangleIcon className="size-3.5 shrink-0 text-(--thread-accent-secondary)" />
    );
  }
  return (
    <CircleDotIcon className="size-3.5 shrink-0 text-(--thread-accent-primary)" />
  );
}

function StatusLabel({ status }: { status: MeetingStatus }) {
  const label: Record<MeetingStatus, { text: string; cls: string }> = {
    scheduled: { text: "scheduled", cls: "text-[oklch(0.7_0.15_70)]" },
    done: { text: "transcribed", cls: "text-(--thread-accent-primary)" },
    processing: { text: "processing", cls: "text-muted-foreground" },
    pending: { text: "pending", cls: "text-muted-foreground" },
    failed: { text: "failed", cls: "text-(--thread-accent-secondary)" },
  };
  const { text, cls } = label[status];
  return (
    <>
      <span aria-hidden>·</span>
      <span className={cn("uppercase tracking-wider", cls)}>{text}</span>
    </>
  );
}

function EmptyState({
  icon: Icon,
  text,
}: {
  icon: typeof CalendarIcon;
  text: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-16 text-center">
      <Icon className="size-7 text-muted-foreground/40" />
      <p className="max-w-xs font-mono text-[12px] text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

function MeetingRowSkeletons() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-3 px-4 py-3",
            i !== 0 && "border-t border-border",
          )}
        >
          <span className="size-3.5 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
            <span className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </>
  );
}
