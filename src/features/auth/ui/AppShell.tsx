"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  MessageSquareIcon,
  VideoIcon,
  SunIcon,
  MoonIcon,
  LogOutIcon,
  LogInIcon,
  MenuIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/shared/lib/utils";
import { useSession, signIn, signOut } from "@/features/auth/model/auth-client";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/shared/ui/tooltip";
import { OnboardingDialog } from "@/features/auth/ui/OnboardingDialog";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Matches child routes (e.g. /meetings/[botId]) for the active state. */
  match: (path: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Chat",
    icon: MessageSquareIcon,
    match: (p) => p === "/",
  },
  {
    href: "/meetings",
    label: "Meetings",
    icon: VideoIcon,
    // The index and every meeting notebook (/meetings/[botId]) light up here.
    match: (p) => p.startsWith("/meetings"),
  },
];

/**
 * Global navigation shell for the authenticated screens. Before, each page
 * was an island with no way to discover the others; now there's a fixed rail
 * on the left (desktop) and a floating menu (mobile) linking Chat ⇆ Meetings,
 * plus a theme toggle and sign-out action. It's self-contained
 * (position: fixed) and doesn't wrap the content — pages just add
 * `md:pl-14` so they don't sit under the rail.
 */
export function AppShell() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Closes the mobile menu on navigation. Syncing with `pathname` in an
  // effect is the correct approach here — it can't be derived during render
  // without losing the manual toggle.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <>
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center border-r bg-background py-3 md:flex">
        <Link
          href="/"
          aria-label="Casper Agent"
          className="mb-2 flex size-9 items-center justify-center rounded-[8px] border bg-background text-(--thread-accent-primary)"
        >
          <span className="font-mono text-sm font-semibold">C</span>
        </Link>

        <nav className="flex flex-1 flex-col items-center gap-1 pt-2">
          {NAV.map((item) => (
            <RailLink key={item.href} item={item} active={item.match(pathname)} />
          ))}
        </nav>

        <div className="flex flex-col items-center gap-1">
          <ThemeToggle />
          <UserButton />
        </div>
      </aside>

      {/* Mobile menu */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          className="fixed left-3 top-3 z-50 flex size-9 items-center justify-center rounded-[8px] border bg-background text-muted-foreground shadow-sm"
        >
          {mobileOpen ? (
            <XIcon className="size-4" />
          ) : (
            <MenuIcon className="size-4" />
          )}
        </button>

        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40"
              onClick={() => setMobileOpen(false)}
            />
            <div className="fixed left-3 top-14 z-50 flex w-48 flex-col gap-1 rounded-[10px] border bg-popover p-2 shadow-lg">
              {NAV.map((item) => {
                const active = item.match(pathname);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2.5 rounded-[6px] px-3 py-2.5 text-sm",
                      active
                        ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
              <div className="my-1 h-px bg-border" />
              <div className="flex items-center justify-between px-1">
                <ThemeToggle withLabel />
                <UserButton withLabel />
              </div>
            </div>
          </>
        )}
      </div>

      {/* First-use onboarding (self-contained; fires only once) */}
      <OnboardingDialog />
    </>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            href={item.href}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex size-9 items-center justify-center rounded-[8px] transition-colors",
              active
                ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" />
          </Link>
        }
      />
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Mount flag to avoid a theme hydration mismatch (next-themes canonical
  // pattern) — the set can only happen client-side, in the effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  const toggle = () => setTheme(isDark ? "light" : "dark");

  // Avoids a hydration mismatch: before mounting, the server doesn't know the
  // resolved theme — both icon AND aria-label need the same neutral
  // placeholder, otherwise the aria-label diverges on hydrate (isDark is
  // undefined during SSR).
  const Icon = !mounted ? SunIcon : isDark ? SunIcon : MoonIcon;
  const label = !mounted ? "Toggle theme" : isDark ? "Light theme" : "Dark theme";

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Icon className="size-[18px]" />
      </button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon className="size-[18px]" />
          </button>
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function UserButton({ withLabel = false }: { withLabel?: boolean }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  if (isPending) {
    return (
      <span className="flex size-9 items-center justify-center text-muted-foreground">
        <span className="size-4 animate-pulse rounded-full bg-muted" />
      </span>
    );
  }

  if (!session?.user) {
    const onLogin = () =>
      signIn.social({
        provider: "google",
        callbackURL:
          typeof window !== "undefined" ? window.location.pathname : "/",
      });
    return (
      <button
        type="button"
        onClick={onLogin}
        aria-label="Sign in"
        className="flex size-9 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <LogInIcon className="size-[18px]" />
      </button>
    );
  }

  const initial = (session.user.name ?? session.user.email ?? "?")
    .charAt(0)
    .toUpperCase();

  const onSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      // Land on the public root and re-fetch session so the shell
      // re-renders as signed-out instead of falling back to Google sign-in.
      router.replace("/");
      router.refresh();
    }
  };

  const button = (
    <button
      type="button"
      onClick={onSignOut}
      disabled={signingOut}
      aria-label="Sign out"
      title={session.user.email ?? "Sign out"}
      className="group relative flex size-9 items-center justify-center rounded-full disabled:opacity-60"
    >
      <span className="flex size-7 items-center justify-center rounded-full border bg-background font-mono text-xs text-foreground group-hover:opacity-0">
        {initial}
      </span>
      <LogOutIcon className="absolute size-[18px] text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  );

  if (withLabel) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">
        {session.user.email ?? "Sign out"} · sign out
      </TooltipContent>
    </Tooltip>
  );
}
