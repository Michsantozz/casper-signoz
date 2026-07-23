"use client";

/**
 * Longitudinal team-health dashboard — how the team's meeting dynamics evolve
 * ACROSS meetings over time. This is the layer meeting tools don't ship: not
 * "who talked in this call" but "who is fading, who is taking over the room, is
 * friction rising, is the team getting less balanced" — people-analytics of a
 * team over time. Reads GET /api/team-trends (aggregated dynamics snapshots).
 */

import {
  useTeamTrends,
  type TeamSignal,
  type ParticipantTrend,
} from "@/features/meetings/model/queries";
import {
  ActivityIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  MinusIcon,
  UserMinusIcon,
  CrownIcon,
  ZapIcon,
  ScaleIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";

const SIGNAL_ICON: Record<TeamSignal["kind"], LucideIcon> = {
  fading_participant: UserMinusIcon,
  rising_dominance: CrownIcon,
  rising_friction: ZapIcon,
  declining_balance: ScaleIcon,
};

export function TeamTrends() {
  const { data, isLoading, isError } = useTeamTrends();

  if (isLoading) {
    return <Frame>Loading team trends…</Frame>;
  }
  if (isError) {
    return <Frame>Couldn&apos;t load team trends.</Frame>;
  }
  if (!data?.available || !data.trends) {
    return (
      <Frame>
        <p className="text-sm text-muted-foreground">
          Not enough analyzed meetings yet. Team trends appear once you have at
          least 3 recorded meetings with speaker data.
          {data ? ` (${data.meetingsWithDynamics} so far)` : ""}
        </p>
      </Frame>
    );
  }

  const t = data.trends;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <ActivityIcon className="size-5 text-(--thread-accent-primary)" />
        <h1 className="text-lg font-semibold">Team dynamics over time</h1>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {t.meetings} meetings
        </span>
      </header>

      {/* actionable signals — the "act on it" layer */}
      {t.signals.length > 0 && (
        <section className="flex flex-col gap-2">
          {t.signals.map((s, i) => {
            const Icon = SIGNAL_ICON[s.kind];
            return (
              <div
                key={i}
                className="flex items-start gap-3 rounded-[8px] border bg-background p-3"
              >
                <div
                  className={cn(
                    "mt-0.5 rounded-[5px] p-1.5",
                    s.severity >= 0.5
                      ? "bg-(--thread-accent-secondary)/15 text-(--thread-accent-secondary)"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" />
                </div>
                <p className="text-sm leading-relaxed">{s.message}</p>
              </div>
            );
          })}
        </section>
      )}

      {/* team balance over time */}
      <section className="rounded-[8px] border bg-background p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            balance over time
          </span>
          <TrendPill slope={t.balanceSlope} up="more balanced" down="concentrating" />
        </div>
        <Sparkline points={t.balanceSeries.map((b) => b.balance)} />
      </section>

      {/* per-person trajectories */}
      <section className="rounded-[8px] border bg-background p-4">
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          participants
        </span>
        <div className="mt-2 flex flex-col gap-3">
          {t.participants.map((p, i) => (
            <ParticipantRow key={i} p={p} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ParticipantRow({ p }: { p: ParticipantTrend }) {
  const first = Math.round(p.firstShare * 100);
  const last = Math.round(p.lastShare * 100);
  const delta = last - first;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 truncate text-sm">{p.name}</span>
      <div className="flex flex-1 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="tabular-nums">{first}%</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-(--thread-accent-primary)"
            style={{ width: `${last}%` }}
          />
        </div>
        <span className="tabular-nums">{last}%</span>
      </div>
      <span className="flex w-16 shrink-0 items-center justify-end gap-1 font-mono text-[11px]">
        <DeltaArrow delta={delta} />
        <span
          className={cn(
            "tabular-nums",
            delta > 2
              ? "text-(--thread-accent-primary)"
              : delta < -2
                ? "text-(--thread-accent-secondary)"
                : "text-muted-foreground",
          )}
        >
          {delta > 0 ? "+" : ""}
          {delta}
        </span>
      </span>
    </div>
  );
}

function DeltaArrow({ delta }: { delta: number }) {
  if (delta > 2)
    return <TrendingUpIcon className="size-3 text-(--thread-accent-primary)" />;
  if (delta < -2)
    return (
      <TrendingDownIcon className="size-3 text-(--thread-accent-secondary)" />
    );
  return <MinusIcon className="size-3 text-muted-foreground" />;
}

function TrendPill({
  slope,
  up,
  down,
}: {
  slope: number;
  up: string;
  down: string;
}) {
  const flat = Math.abs(slope) < 0.005;
  const Icon = flat ? MinusIcon : slope > 0 ? TrendingUpIcon : TrendingDownIcon;
  const label = flat ? "steady" : slope > 0 ? up : down;
  const color = flat
    ? "text-muted-foreground"
    : slope > 0
      ? "text-(--thread-accent-primary)"
      : "text-(--thread-accent-secondary)";
  return (
    <span className={cn("flex items-center gap-1 font-mono text-[11px]", color)}>
      <Icon className="size-3" />
      {label}
    </span>
  );
}

/** Tiny inline SVG sparkline (no chart lib). Values expected in 0..1. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">Not enough points yet.</p>
    );
  }
  const w = 100;
  const h = 28;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-8 w-full"
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke="var(--thread-accent-primary)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="rounded-[8px] border bg-background p-6 text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
