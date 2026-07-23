"use client";

import { useEffect, useRef, useState } from "react";
import {
  SparklesIcon,
  LoaderIcon,
  MailIcon,
  KeyRoundIcon,
  MailCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/utils";
import { signIn, authClient } from "@/features/auth/model/auth-client";

/**
 * Home sign-in screen. The chat (LLM + meeting tools) requires sign in;
 * without a session the user sees this. Three sign-in methods (Tier 1):
 *  - Google (social OAuth)
 *  - Magic link (passwordless email, via Resend)
 *  - Email + password (with signup and "forgot password")
 */

type Mode = "magic" | "password";

// Error messages returned by better-auth on magic link verification
// (redirect → errorCallbackURL with ?error=). Without this an expired token
// lands on the home page with no feedback at all.
const AUTH_ERROR_MSG: Record<string, string> = {
  INVALID_TOKEN: "Invalid or already used link. Request a new one below.",
  EXPIRED_TOKEN: "Link expired. Request a new one below.",
  failed_to_create_user: "Could not create the account. Please try again.",
  failed_to_create_session: "Failed to start the session. Please try again.",
};

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>("magic");

  // A failed magic link verification comes back here with ?error=. Shows the
  // toast and clears the query so it doesn't repeat on navigate/reload.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (!error) return;
    toast.error(AUTH_ERROR_MSG[error] ?? "Failed to sign in. Please try again.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-4"
      style={{
        ["--thread-max-width" as string]: "28rem",
      }}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
          />
          meeting assistant · recall.ai
        </span>
        <span className="flex size-12 items-center justify-center rounded-[10px] border bg-background">
          <SparklesIcon className="size-6 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">Casper Agent</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Your AI meeting assistant: schedule, record, transcribe, and
          summarize your meetings. Sign in to talk to the agent.
        </p>
      </div>

      {/* EvilCharts frame: outer wrapper (8px) → mono header bar → inner card (5px) */}
      <div className="w-full rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <KeyRoundIcon className="size-3.5" />
            sign in
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
            />
            meeting-assistant
          </span>
        </div>

        <div className="flex w-full flex-col gap-4 rounded-[5px] border bg-background p-5">
        {/* Google */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => signIn.social({ provider: "google", callbackURL: "/" })}
        >
          Sign in with Google
        </Button>

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            or
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Magic link / password switcher */}
        <div className="flex rounded-[5px] border p-0.5">
          <TabButton
            active={mode === "magic"}
            onClick={() => setMode("magic")}
            icon={MailIcon}
            label="Magic link"
          />
          <TabButton
            active={mode === "password"}
            onClick={() => setMode("password")}
            icon={KeyRoundIcon}
            label="Password"
          />
        </div>

        {mode === "magic" ? <MagicLinkForm /> : <PasswordForm />}
        </div>
      </div>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MailIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-[3px] py-1.5 font-mono text-xs transition-colors",
        active
          ? "bg-(--thread-accent-primary-soft) text-(--thread-accent-primary)"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/* ── Magic link ──────────────────────────────────────────────────────── */

function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: "/",
      // An invalid/expired token on verification redirects back to home with
      // ?error=; LoginScreen reads it and shows the toast. Without this the
      // error is swallowed.
      errorCallbackURL: "/",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Failed to send the link.");
      return;
    }
    setSent(true);
    toast.success("Link sent! Check your email.");
  }

  if (sent) {
    return (
      <p className="rounded-[5px] border bg-(--thread-accent-primary-soft)/30 px-3 py-4 text-center text-sm text-foreground">
        We sent an access link to <strong>{email}</strong>. Open the email and
        click it to sign in.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <Field
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Button type="submit" className="w-full" disabled={busy || !email}>
        {busy ? <Spinner /> : "Send access link"}
      </Button>
    </form>
  );
}

/* ── Email + password ──────────────────────────────────────────────────── */

function PasswordForm() {
  const [isSignup, setIsSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Set after a signup that DIDN'T open a session (email verification required):
  // we swap the form for the "check your inbox / resend" panel.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setBusy(true);

    if (isSignup) {
      const { data, error } = await authClient.signUp.email({
        name: name || email.split("@")[0],
        email,
        password,
        callbackURL: "/",
      });
      setBusy(false);
      if (error) return toast.error(error.message ?? "Sign-up failed.");
      // When email verification is required, better-auth creates the user but
      // NO session (no token) — it sends a verification email instead. Show the
      // "check your inbox" panel with a resend option rather than redirecting
      // (which would just bounce back to this screen, unauthenticated).
      if (!data?.token) {
        setPendingEmail(email);
        toast.success("Account created! Confirm your email to continue.");
        return;
      }
      toast.success("Account created! Signing in…");
      window.location.href = "/";
      return;
    }

    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: "/",
    });
    setBusy(false);
    if (error) {
      // An unverified account can't sign in when verification is enforced —
      // route the user to the resend panel instead of a dead-end error.
      if (isVerificationError(error)) {
        setPendingEmail(email);
        return;
      }
      return toast.error(error.message ?? "Invalid email or password.");
    }
    window.location.href = "/";
  }

  if (pendingEmail) {
    return (
      <VerifyEmailPending
        email={pendingEmail}
        onBack={() => setPendingEmail(null)}
      />
    );
  }

  async function forgot() {
    if (!email) return toast.error("Enter your email first.");
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    if (error) return toast.error(error.message ?? "Failed to send.");
    toast.success("If the email exists, we sent a reset link.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      {isSignup && (
        <Field
          type="text"
          placeholder="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
        />
      )}
      <Field
        type="email"
        placeholder="you@email.com"
        value={email}
        onChange={setEmail}
        autoComplete="email"
      />
      <Field
        type="password"
        placeholder="Password"
        value={password}
        onChange={setPassword}
        autoComplete={isSignup ? "new-password" : "current-password"}
      />
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? <Spinner /> : isSignup ? "Sign up" : "Sign in"}
      </Button>

      <div className="flex items-center justify-between pt-0.5">
        <button
          type="button"
          onClick={() => setIsSignup((v) => !v)}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {isSignup ? "Already have an account" : "Sign up"}
        </button>
        {!isSignup && (
          <button
            type="button"
            onClick={forgot}
            className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            Forgot password
          </button>
        )}
      </div>
    </form>
  );
}

/* ── email verification pending / resend ─────────────────────────────── */

/** True when a sign-in failed specifically because the email isn't verified. */
function isVerificationError(error: {
  code?: string;
  status?: number;
  message?: string;
}): boolean {
  return (
    error.code === "EMAIL_NOT_VERIFIED" ||
    error.status === 403 ||
    /verif/i.test(error.message ?? "")
  );
}

const RESEND_COOLDOWN_S = 60;

/**
 * "Confirm your email" panel — shown after signup (or a blocked sign-in) when
 * email verification is required. Lets the user resend the verification email,
 * with a cooldown so the button can't be hammered (anti-spam, and the endpoint
 * is rate-limited server-side anyway).
 */
function VerifyEmailPending({
  email,
  onBack,
}: {
  email: string;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Seconds left before "Resend" is available again. Starts armed (0) so the
  // user can resend immediately if the first email never arrived.
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    timerRef.current = setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cooldown]);

  async function resend() {
    if (busy || cooldown > 0) return;
    setBusy(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/",
    });
    setBusy(false);
    if (error) {
      toast.error(error.message ?? "Could not resend the email.");
      return;
    }
    setCooldown(RESEND_COOLDOWN_S);
    toast.success("Verification email sent again.");
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span className="flex size-11 items-center justify-center rounded-[10px] border bg-background">
        <MailCheckIcon className="size-5 text-(--thread-accent-primary)" />
      </span>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-foreground">
          Confirm your email to finish signing in.
        </p>
        <p className="text-sm text-muted-foreground">
          We sent a verification link to <strong>{email}</strong>. Open it, then
          come back and sign in.
        </p>
      </div>

      <div className="flex w-full flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={resend}
          disabled={busy || cooldown > 0}
        >
          {busy ? (
            <Spinner />
          ) : cooldown > 0 ? (
            `Resend in ${cooldown}s`
          ) : (
            "Resend verification email"
          )}
        </Button>
        <button
          type="button"
          onClick={onBack}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          Use a different email
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Didn&apos;t get it? Check your spam folder, or resend above.
      </p>
    </div>
  );
}

/* ── primitives ──────────────────────────────────────────────────────── */

function Field({
  type,
  placeholder,
  value,
  onChange,
  autoComplete,
}: {
  type: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete={autoComplete}
      className="w-full rounded-[5px] border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-(--thread-accent-primary)"
    />
  );
}

function Spinner() {
  return (
    <LoaderIcon className="size-4 animate-spin [animation-duration:0.6s]" />
  );
}
