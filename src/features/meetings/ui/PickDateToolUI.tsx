"use client";

import { useEffect, useState } from "react";
import { CalendarIcon, CheckIcon, ClockIcon, LoaderIcon } from "lucide-react";
import {
  makeAssistantTool,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Calendar } from "@/shared/ui/calendar";
import { cn } from "@/shared/lib/utils";
import { DEFAULT_TIME_ZONE } from "@/shared/lib/config";

/**
 * pick_date — frontend tool that renders a clickable CALENDAR + TIME PICKER
 * in the chat, with the user's REAL calendar AVAILABILITY.
 *
 * Flow (human-in-the-loop, same as connect_wallet):
 *  1. The agent calls pick_date when it needs the user to choose a day/time.
 *  2. `execute` runs in the browser and returns a "waiting" state — it doesn't block.
 *  3. `render` shows the <Calendar> + a column of time slots. When a day is
 *     chosen, it fetches GET /api/calendar/availability?date&tz and marks each
 *     slot as FREE (clickable) or BUSY (visible, disabled, with the reason).
 *     The user can only click a free slot → addToolResult → back to the agent.
 *  4. sendAutomaticallyWhen enabled: the agent CONTINUES the loop on its own.
 *
 * Critical difference vs. the previous version: the time slots are NO LONGER
 * a fixed grid that ignores the calendar. Before, the user could click an
 * already-busy slot and create_calendar_event would create a silent conflict
 * — now the UI is honest.
 */

type PickDateArgs = {
  /** Short text describing what the user is choosing (e.g. "meeting day"). */
  prompt?: string;
  /** Minimum selectable ISO date (default: today — no picking the past). */
  minIso?: string;
};

type PickDateResult = {
  picked: boolean;
  /** Chosen date (yyyy-mm-dd). */
  dateIso: string | null;
  /** Chosen time (HH:mm). */
  timeHm: string | null;
  /** Combined date+time in local ISO (yyyy-mm-ddTHH:mm). */
  datetimeIso: string | null;
};

/** A slot coming from the availability API. */
type Slot = {
  timeHm: string;
  datetimeIso: string;
  busy: boolean;
  reason?: string;
};

type AvailabilityResponse = {
  dateIso: string;
  timeZone: string;
  slots: Slot[];
  noCalendar: boolean;
};

/** Browser timezone (e.g. "America/Sao_Paulo"), falling back to the app default. */
function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

/** ISO yyyy-mm-dd in the local timezone (doesn't shift the day via UTC). */
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Registry of pending resolvers per toolCallId. `execute` creates a Promise that
 * does NOT resolve until the user clicks — this way the tool call only
 * "completes" after the actual choice, and sendAutomaticallyWhen doesn't
 * resend a premature picked:false.
 *
 * It never stays pending forever, though: `execute` also settles it on run
 * cancellation (abortSignal) and after a hard timeout. An unsettled
 * frontend-tool call is what left the agent hanging in "thinking…" and
 * persisted an orphaned tool-call that reopened stale.
 */
const pending = new Map<string, (r: PickDateResult) => void>();

/** Settles one waiting `execute` call (no-op if already settled/unknown). */
function resolvePending(toolCallId: string, result: PickDateResult) {
  const fn = pending.get(toolCallId);
  if (fn) {
    pending.delete(toolCallId);
    fn(result);
  }
}

/** A not-picked terminal result (abort/timeout). The card renders it as-is. */
function notPicked(): PickDateResult {
  return { picked: false, dateIso: null, timeHm: null, datetimeIso: null };
}

export function PickDateCard({
  args,
  result,
  toolCallId,
}: ToolCallMessagePartProps<PickDateArgs, PickDateResult>) {
  const [day, setDay] = useState<Date | undefined>();
  const [time, setTime] = useState<string | undefined>();
  const [done, setDone] = useState<PickDateResult | undefined>();

  const [avail, setAvail] = useState<AvailabilityResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Browser timezone, resolved once (lazy useState initializer).
  const [tz] = useState(browserTz);

  // When a day is chosen, fetch its real availability. Cancel via flag if the
  // user switches days before the response arrives (avoids a state race).
  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    const dateIso = toLocalIso(day);
    // Resets outside the effect's synchronous body (react-hooks/set-state-in-effect
    // rule): a microtask schedules the initial loading state before the fetch resolves.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(undefined);
      setTime(undefined);
      setAvail(undefined);
    });
    fetch(
      `/api/calendar/availability?date=${dateIso}&tz=${encodeURIComponent(tz)}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`failed ${r.status}`);
        return (await r.json()) as AvailabilityResponse;
      })
      .then((data) => {
        if (!cancelled) setAvail(data);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "error loading time slots");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [day, tz]);

  // Already answered: show what was chosen, hide the picker.
  const settled = result?.picked ? result : done;
  if (settled?.picked && settled.dateIso) {
    const d = new Date(`${settled.dateIso}T00:00:00`);
    return (
      <ToolCard label="time chosen" tone="success" meta="ok">
        <p className="font-mono text-sm capitalize">
          {fmtDay(d)}
          {settled.timeHm ? (
            <span className="text-(--thread-accent-primary)">
              {" "}
              · {settled.timeHm}
            </span>
          ) : null}
        </p>
      </ToolCard>
    );
  }

  const min = args.minIso ? new Date(`${args.minIso}T00:00:00`) : new Date();
  min.setHours(0, 0, 0, 0);

  /** Only a FREE slot confirms. Resolves the execute Promise → the tool call
   *  completes and the agent continues the loop (sendAutomaticallyWhen). */
  function confirm(nextDay: Date, slot: Slot) {
    if (slot.busy) return;
    const dateIso = toLocalIso(nextDay);
    const res: PickDateResult = {
      picked: true,
      dateIso,
      timeHm: slot.timeHm,
      datetimeIso: slot.datetimeIso,
    };
    setTime(slot.timeHm);
    setDone(res);
    resolvePending(toolCallId, res);
  }

  const slots = avail?.slots ?? [];
  const freeCount = slots.filter((s) => !s.busy).length;

  return (
    <ToolCard label={args.prompt ?? "choose day and time"}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        {/* Calendar */}
        <Calendar
          mode="single"
          selected={day}
          onSelect={(d) => setDay(d ?? undefined)}
          disabled={{ before: min }}
          className="rounded-[5px] border bg-background p-2"
        />

        {/* Time slots column (scrollable) */}
        <div className="flex flex-col rounded-[5px] border bg-background">
          <div className="flex items-center justify-between gap-1.5 border-b px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {loading ? (
                <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
              ) : (
                <ClockIcon className="size-3.5" />
              )}
              {day ? (
                <span className="capitalize text-foreground">
                  {day.toLocaleDateString("en-US", {
                    weekday: "long",
                    day: "2-digit",
                  })}
                </span>
              ) : (
                "time"
              )}
            </span>
            {day && !loading && !error ? (
              <span>{freeCount} free</span>
            ) : null}
          </div>

          <div className="grid max-h-[248px] grid-cols-2 gap-1.5 overflow-y-auto p-2 sm:w-[184px] sm:grid-cols-1">
            {!day ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                choose a day
              </p>
            ) : error ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-(--thread-accent-secondary)">
                {error}
              </p>
            ) : loading ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                loading…
              </p>
            ) : freeCount === 0 ? (
              <p className="col-span-full px-1 py-2 text-center font-mono text-[11px] text-muted-foreground">
                no free time slots on this day
              </p>
            ) : (
              slots.map((slot) => {
                const active = time === slot.timeHm && !slot.busy;
                return (
                  <button
                    key={slot.timeHm}
                    type="button"
                    disabled={slot.busy}
                    title={slot.busy ? slot.reason ?? "busy" : undefined}
                    onClick={() => day && confirm(day, slot)}
                    className={cn(
                      "rounded-[5px] border px-2 py-1.5 text-center font-mono text-sm transition-colors",
                      slot.busy
                        ? "cursor-not-allowed border-dashed text-muted-foreground/60 line-through opacity-60"
                        : active
                          ? "border-transparent bg-(--thread-accent-primary) text-background"
                          : "bg-background hover:bg-(--thread-frame-outer)",
                    )}
                  >
                    {slot.timeHm}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
        <span>
          {!day
            ? "choose a day, then the time"
            : avail?.noCalendar
              ? "calendar not connected — time slots not checked"
              : "strikethrough = busy on your calendar"}
        </span>
        <span>timezone: {avail?.timeZone ?? tz}</span>
      </div>
    </ToolCard>
  );
}

export const PickDateTool = makeAssistantTool<PickDateArgs, PickDateResult>({
  toolName: "pick_date",
  type: "frontend",
  description:
    "Shows a clickable CALENDAR + TIME picker in the chat for the user to choose a day and time. Time slots (09:00–18:00) reflect the user's REAL CALENDAR: busy ones show struck through and non-clickable — the user can only choose a free slot. ALWAYS use this when you need a date/time from the user (e.g. when sending the bot, scheduling a meeting) instead of asking in text. Returns { picked, dateIso (yyyy-mm-dd), timeHm (HH:mm), datetimeIso (yyyy-mm-ddTHH:mm) } — the returned time slot is ALREADY free. Then use datetimeIso (e.g. as join_at in send_bot_to_meeting / schedule_bot_for_event). minIso (optional) sets the minimum selectable day.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      minIso: { type: "string" },
    },
    additionalProperties: false,
  },
  // execute does NOT resolve right away: it stays pending until the user clicks
  // a FREE slot in render (confirm → resolvePending), so sendAutomaticallyWhen
  // doesn't resend a premature picked:false. But it ALSO settles on run
  // cancellation (abortSignal) and after a hard timeout — never pending forever,
  // which is what hung the agent in "thinking…" and persisted an orphaned call.
  execute: async (_args, { toolCallId, abortSignal }) =>
    new Promise<PickDateResult>((resolve) => {
      let settled = false;
      const settle = (r: PickDateResult) => {
        if (settled) return;
        settled = true;
        pending.delete(toolCallId);
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => settle(notPicked());
      abortSignal.addEventListener("abort", onAbort, { once: true });
      // Backstop: 5 min is well past the time to pick a slot.
      const timer = setTimeout(() => settle(notPicked()), 5 * 60_000);
      pending.set(toolCallId, settle);
    }),
  render: PickDateCard,
});

/* ── visual card (mirrors the ToolCard from other ToolUIs) ──────────────── */

type Tone = "default" | "success";

function ToolCard({
  label,
  meta,
  tone = "default",
  running = false,
  children,
}: {
  label: string;
  meta?: string;
  tone?: Tone;
  running?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-2 w-fit max-w-full rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          {running ? (
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
          ) : (
            <CalendarIcon className="size-3.5" />
          )}
          meeting / {label}
        </span>
        {tone === "success" ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
            <CheckIcon className="size-3" />
            {meta ?? "done"}
          </span>
        ) : meta ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-[1px] bg-(--thread-accent-secondary)",
              )}
            />
            {meta}
          </span>
        ) : null}
      </div>
      {children && (
        <div className="flex flex-col gap-1.5 rounded-[5px] border bg-background p-2">
          {children}
        </div>
      )}
    </div>
  );
}
