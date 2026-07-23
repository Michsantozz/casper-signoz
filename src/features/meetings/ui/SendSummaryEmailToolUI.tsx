"use client";

import { useState } from "react";
import {
  CheckIcon,
  LoaderIcon,
  MailIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import {
  makeAssistantTool,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";

/**
 * confirm_send_summary_email — frontend tool that renders a CONFIRMATION card
 * (recipient + optional note + Send/Cancel) in the chat before emailing a
 * meeting's minutes to someone.
 *
 * Human-in-the-loop, and the send is CLIENT-driven: the actual email fires from
 * the Send button here (POST /api/meetings/{botId}/email-summary), never from
 * the model. The agent only proposes the recipient; the user must click Send.
 * This makes it impossible for the LLM to email an arbitrary address on its own.
 *
 * Flow (mirrors pick_date):
 *  1. The agent calls confirm_send_summary_email with { botId, to?, note? }.
 *  2. `execute` runs in the browser and stays pending (doesn't block the agent).
 *  3. `render` shows the editable recipient + note + Send/Cancel. On Send it
 *     POSTs the request; on success/cancel it resolves the tool call so the
 *     agent continues (sendAutomaticallyWhen).
 */

type SendArgs = {
  /** The meeting to share (Recall botId). Required. */
  botId: string;
  /** Suggested recipient email — the user can edit it before sending. */
  to?: string;
  /** Optional note the agent drafted; the user can edit it. */
  note?: string;
};

type SendResult = {
  sent: boolean;
  to: string | null;
  /** Set when the send failed or was declined (surfaced to the agent). */
  error?: string;
};

/**
 * Registry of pending resolvers per toolCallId — same pattern as PickDateToolUI:
 * `execute` stays pending until the user acts (send/cancel) or the call aborts/
 * times out, so sendAutomaticallyWhen doesn't resend a premature result and the
 * agent never hangs on an unsettled frontend tool.
 */
const pending = new Map<string, (r: SendResult) => void>();

function resolvePending(toolCallId: string, result: SendResult) {
  const fn = pending.get(toolCallId);
  if (fn) {
    pending.delete(toolCallId);
    fn(result);
  }
}

function notSent(error: string): SendResult {
  return { sent: false, to: null, error };
}

/** Client-side email sanity check (server re-validates authoritatively). */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export function SendSummaryEmailCard({
  args,
  result,
  toolCallId,
}: ToolCallMessagePartProps<SendArgs, SendResult>) {
  const [to, setTo] = useState(args.to ?? "");
  const [note, setNote] = useState(args.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<SendResult | undefined>();

  // Already settled: show the outcome, hide the form.
  const settled = result?.sent ? result : done;
  if (settled?.sent && settled.to) {
    return (
      <ToolCard label="summary sent" tone="success" meta="ok">
        <p className="font-mono text-sm">
          Sent to{" "}
          <span className="text-(--thread-accent-primary)">{settled.to}</span>
        </p>
      </ToolCard>
    );
  }

  async function send() {
    const recipient = to.trim();
    if (!looksLikeEmail(recipient)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(args.botId)}/email-summary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: recipient,
            note: note.trim() || undefined,
          }),
        },
      );
      if (res.status === 429) {
        setError("Too many emails sent. Try again later.");
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        const msg =
          body.error === "not_ready"
            ? "The minutes aren't ready yet."
            : body.error === "no_summary"
              ? "No summary is available for this meeting."
              : "Couldn't send the email.";
        setError(msg);
        setBusy(false);
        return;
      }
      const res2: SendResult = { sent: true, to: recipient };
      setDone(res2);
      resolvePending(toolCallId, res2);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  function cancel() {
    const res = notSent("cancelled");
    setDone(res);
    resolvePending(toolCallId, res);
  }

  return (
    <ToolCard label="send minutes by email">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[11px] text-muted-foreground">
            recipient
          </span>
          <input
            type="email"
            inputMode="email"
            value={to}
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@company.com"
            className="rounded-[5px] border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-(--thread-accent-primary) disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[11px] text-muted-foreground">
            note (optional)
          </span>
          <textarea
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="A short message to include…"
            className="resize-none rounded-[5px] border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-(--thread-accent-primary) disabled:opacity-60"
          />
        </label>

        {error ? (
          <p className="font-mono text-[11px] text-(--thread-accent-secondary)">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-[5px] border bg-background px-3 py-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:bg-(--thread-frame-outer) disabled:opacity-50"
          >
            <XIcon className="size-3.5" />
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-[5px] border border-transparent bg-(--thread-accent-primary) px-3 py-1.5 font-mono text-[12px] text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin [animation-duration:0.6s]" />
            ) : (
              <SendIcon className="size-3.5" />
            )}
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </ToolCard>
  );
}

export const SendSummaryEmailTool = makeAssistantTool<SendArgs, SendResult>({
  toolName: "confirm_send_summary_email",
  type: "frontend",
  description:
    "Shows a confirmation card in the chat to email a meeting's minutes to someone (any recipient, e.g. a manager who didn't attend). " +
    "ALWAYS use this when the user asks to send/share/email a meeting summary to a person — never send silently. " +
    "Pass botId (the meeting to share) and, when the user named a recipient, `to` (their email) and an optional `note`. " +
    "The user reviews the recipient and clicks Send; the email is only sent on that click. " +
    "Returns { sent, to } — if sent:false with error 'cancelled', the user declined, so do not retry.",
  parameters: {
    type: "object",
    properties: {
      botId: { type: "string" },
      to: { type: "string" },
      note: { type: "string" },
    },
    required: ["botId"],
    additionalProperties: false,
  },
  execute: async (_args, { toolCallId, abortSignal }) =>
    new Promise<SendResult>((resolve) => {
      let settled = false;
      const settle = (r: SendResult) => {
        if (settled) return;
        settled = true;
        pending.delete(toolCallId);
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => settle(notSent("cancelled"));
      abortSignal.addEventListener("abort", onAbort, { once: true });
      // Backstop: well past the time to review a recipient and click send.
      const timer = setTimeout(() => settle(notSent("timeout")), 5 * 60_000);
      pending.set(toolCallId, settle);
    }),
  render: SendSummaryEmailCard,
});

/* ── visual card (mirrors the ToolCard from PickDateToolUI) ─────────────── */

type Tone = "default" | "success";

function ToolCard({
  label,
  meta,
  tone = "default",
  children,
}: {
  label: string;
  meta?: string;
  tone?: Tone;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-[8px] bg-(--thread-frame-outer) p-1">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
          <MailIcon className="size-3.5" />
          meeting / {label}
        </span>
        {tone === "success" ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-(--thread-accent-primary)">
            <CheckIcon className="size-3" />
            {meta ?? "done"}
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
