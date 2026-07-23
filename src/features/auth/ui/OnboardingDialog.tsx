"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  MessageSquareIcon,
  CalendarIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { useSession } from "@/features/auth/model/auth-client";

const STORAGE_KEY = "casper:onboarded:v1";

type Feature = {
  icon: LucideIcon;
  title: string;
  desc: string;
  href: string;
  cta: string;
};

const FEATURES: Feature[] = [
  {
    icon: MessageSquareIcon,
    title: "Talk to the agent",
    desc: "Schedule meetings, send a recording bot, and turn transcripts into summaries, decisions, and action items — all through conversation.",
    href: "/",
    cta: "Open chat",
  },
  {
    icon: CalendarIcon,
    title: "Meetings & recordings",
    desc: "Connect your calendar, auto-record, and review the minutes, transcript, and participants of every meeting.",
    href: "/",
    cta: "Open chat",
  },
];

/**
 * First-use experience. Before, signing in led straight into a bare chat,
 * with no context on what the product does. Shows once (localStorage flag)
 * a summary of the areas with shortcuts. Self-contained: only fires
 * for an active session and disappears once seen or dismissed.
 */
export function OnboardingDialog() {
  const { data: session, isPending } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isPending || !session?.user) return;
    try {
      // localStorage only exists client-side; opening depends on it, so it's
      // in the effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      /* localStorage unavailable — doesn't block */
    }
  }, [isPending, session?.user]);

  const dismiss = (next: boolean) => {
    if (!next) {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={dismiss}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <span className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
            />
            meeting assistant · recall.ai
          </span>
          <span className="mb-1 flex size-10 items-center justify-center rounded-[10px] border bg-background text-(--thread-accent-primary)">
            <SparklesIcon className="size-5" />
          </span>
          <DialogTitle>Welcome to Casper Agent</DialogTitle>
          <DialogDescription>
            Your AI meeting assistant. Here&apos;s what you can do:
          </DialogDescription>
        </DialogHeader>

        <ul className="flex flex-col gap-3 py-2">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <li
                key={f.href}
                className="flex items-start gap-3 rounded-[5px] border bg-background p-3"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[3px] bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)">
                  <Icon className="size-4" />
                </span>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{f.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {f.desc}
                  </span>
                </div>
                <DialogClose
                  render={
                    <Link
                      href={f.href}
                      className="shrink-0 self-center font-mono text-[11px] text-(--thread-accent-primary) hover:underline"
                    >
                      {f.cta} →
                    </Link>
                  }
                />
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button onClick={() => dismiss(false)}>Get started</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
