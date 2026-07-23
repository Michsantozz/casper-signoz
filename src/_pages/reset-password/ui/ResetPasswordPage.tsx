"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { KeyRoundIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { authClient } from "@/features/auth/model/auth-client";

/**
 * Password reset page. The email link (sendResetPassword → Resend) lands
 * here with ?token=. The user sets a new password; on success, returns home.
 */
export function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return toast.error("Invalid or expired link.");
    if (password.length < 8)
      return toast.error("Password must be at least 8 characters.");
    if (password !== confirm) return toast.error("Passwords don't match.");

    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Failed to reset password.");
    toast.success("Password reset! Please sign in.");
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span
            aria-hidden
            className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
          />
          meeting assistant · recall.ai
        </span>
        <span className="flex size-12 items-center justify-center rounded-[10px] border bg-background">
          <KeyRoundIcon className="size-6 text-(--thread-accent-primary)" />
        </span>
        <h1 className="font-semibold text-2xl tracking-tight">New password</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Set a new password for your account.
        </p>
      </div>

      {/* EvilCharts frame: outer wrapper (8px) → mono header bar → inner card (5px) */}
      <div className="w-full rounded-[8px] bg-(--thread-frame-outer) p-1">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <KeyRoundIcon className="size-3.5" />
            reset
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-[1px] bg-(--thread-accent-primary)"
            />
            meeting-assistant
          </span>
        </div>

        <form
          onSubmit={submit}
          className="flex w-full flex-col gap-2.5 rounded-[5px] border bg-background p-5"
        >
          <input
            type="password"
            placeholder="New password (min. 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full rounded-[5px] border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-(--thread-accent-primary)"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="w-full rounded-[5px] border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-(--thread-accent-primary)"
          />
          <Button type="submit" className="w-full" disabled={busy || !token}>
            {busy ? (
              <LoaderIcon className="size-4 animate-spin [animation-duration:0.6s]" />
            ) : (
              "Reset password"
            )}
          </Button>
        </form>
      </div>
    </main>
  );
}
