import "server-only";
import { Resend } from "resend";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { user } from "@/shared/db/auth-schema";
import { appPublicUrl } from "@/shared/lib/config";

/**
 * Transactional email sending (Resend). External PUSH channel — reaches the
 * user even when logged out (minutes ready), complementing the in-app bell.
 *
 * Graceful degradation: without RESEND_API_KEY, sendEmail becomes a no-op
 * (logs in dev) and NEVER throws — it must not bring down the bot webhook or
 * request creation. Enabling the channel = setting RESEND_API_KEY and
 * EMAIL_FROM in the env.
 */

const globalForResend = globalThis as unknown as { __resend?: Resend | null };

function getClient(): Resend | null {
  if (globalForResend.__resend !== undefined) return globalForResend.__resend;
  const apiKey = process.env.RESEND_API_KEY;
  globalForResend.__resend = apiKey ? new Resend(apiKey) : null;
  return globalForResend.__resend;
}

/** Configured sender (domain verified in Resend), or the default sandbox. */
function fromAddress(): string {
  return process.env.EMAIL_FROM ?? "CasperAgent <onboarding@resend.dev>";
}

/** Public base URL of the app, to build absolute links in emails. */
function appUrl(): string {
  return appPublicUrl();
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const client = getClient();
  if (!client) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[email:noop] to ${input.to} — "${input.subject}"`);
    }
    return;
  }
  try {
    await client.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
  } catch (err) {
    // Never propagates: email is best-effort, doesn't block the flow that triggered it.
    console.error(
      `[email] failed to send to ${input.to}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Fetches a user's email by id (better-auth), or null. */
export async function userEmailById(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Fetches a user's display name + email by id (better-auth), or null. */
export async function userIdentityById(
  userId: string,
): Promise<{ name: string | null; email: string } | null> {
  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? { name: row.name ?? null, email: row.email } : null;
}

/**
 * Design tokens mirrored from the app theme (globals.css). Email clients don't
 * support oklch() or CSS variables, so the notebook's terminal/EvilCharts
 * identity is baked as fixed hex here — kept in sync with `:root` in globals.css.
 */
const T = {
  // primary accent — the notebook green (oklch(0.5 0.13 165))
  accent: "#007950",
  accentSoft: "#e6f2ec",
  // secondary accent — red (oklch(0.5 0.2 12)), used sparingly
  danger: "#b90044",
  frame: "#f2f2f2", // --thread-frame-outer
  bg: "#ffffff",
  fg: "#0a0a0a",
  muted: "#737373", // --muted-foreground
  border: "#e5e5e5",
  mono: "'JetBrains Mono','SF Mono',ui-monospace,Menlo,Consolas,monospace",
  sans: "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
} as const;

/**
 * Email layout mirroring the in-app meeting notebook: a terminal-style framed
 * card with a mono-uppercase header (live pulse dot + "casperagent · notebook"),
 * an inner `border bg-background` content card, and a mono footer. Buttons use
 * the app's green accent and 5px radius.
 *
 * Fixed hex only (no oklch/CSS vars) so it renders identically across mail
 * clients. `dark` toggles a dark-inverted palette for the "minutes ready" push,
 * matching the app's dark notebook.
 */
function shell(
  title: string,
  body: string,
  cta?: { label: string; href: string },
): string {
  const button = cta
    ? `<a href="${cta.href}" style="display:inline-block;margin-top:20px;padding:11px 20px;background:${T.accent};color:#ffffff;border-radius:5px;text-decoration:none;font-family:${T.mono};font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase">${cta.label} &rarr;</a>`
    : "";
  return `<div style="margin:0;padding:24px 12px;background:${T.frame};font-family:${T.sans}">
    <div style="max-width:544px;margin:0 auto">
      <!-- header: "C" brand badge + mono uppercase label + pulse dot, mirrors the app rail + notebook top bar -->
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:12px">
        <tr>
          <td style="width:34px;vertical-align:middle">
            <span style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;border:1px solid ${T.border};border-radius:8px;background:${T.bg};font-family:${T.mono};font-size:14px;font-weight:700;color:${T.accent}">C</span>
          </td>
          <td style="vertical-align:middle;padding-left:10px;font-family:${T.mono};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${T.muted}">
            <span style="display:inline-block;width:6px;height:6px;border-radius:1px;background:${T.accent};vertical-align:middle;margin-right:7px"></span>casperagent &middot; notebook
          </td>
        </tr>
      </table>
      <!-- inner content card: border + bg-background -->
      <div style="background:${T.bg};border:1px solid ${T.border};border-radius:8px;padding:24px 24px 26px">
        <h1 style="font-family:${T.sans};font-size:19px;font-weight:600;letter-spacing:-0.01em;margin:0 0 10px;color:${T.fg}">${title}</h1>
        <div style="font-family:${T.sans};font-size:14px;line-height:1.6;color:#333333">${body}</div>
        ${button}
      </div>
      <p style="margin:16px 4px 0;font-family:${T.mono};font-size:10px;letter-spacing:0.06em;color:#a3a3a3">CasperAgent &middot; meetings, recorded and summarized</p>
    </div>
  </div>`;
}

/** "Minutes ready" email — triggered by the bot webhook at the end of the meeting. */
export async function emailMeetingSummaryReady(input: {
  userId: string;
  detail: string;
  /** Bot id, for the deep link straight to the meeting notebook. */
  botId?: string;
}): Promise<void> {
  const to = await userEmailById(input.userId);
  if (!to) return;
  // Deep-link to the meeting notebook when we know the bot; else the index.
  const href = input.botId
    ? `${appUrl()}/meetings/${input.botId}`
    : `${appUrl()}/meetings`;
  await sendEmail({
    to,
    subject: "Meeting minutes ready",
    html: shell(
      "Your minutes are ready",
      `The meeting${input.detail} has been processed. Review the summary, decisions, and action items.`,
      { label: "Open minutes", href },
    ),
  });
}

/** Account verification email (better-auth emailVerification). */
export async function emailVerifyAccount(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Confirm your email — CasperAgent",
    html: shell(
      "Confirm your email",
      "To activate your CasperAgent account, please confirm this email address.",
      { label: "Confirm email", href: input.url },
    ),
  });
}

/** Password reset email (better-auth sendResetPassword). */
export async function emailResetPassword(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Reset password — CasperAgent",
    html: shell(
      "Reset your password",
      "We received a request to reset your password. If this wasn't you, ignore this email.",
      { label: "Create new password", href: input.url },
    ),
  });
}

/** Magic link email (better-auth magicLink plugin). */
export async function emailMagicLink(input: {
  to: string;
  url: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "Your access link — CasperAgent",
    html: shell(
      "Sign in to CasperAgent",
      "Click the button to sign in. The link expires in a few minutes and can only be used once.",
      { label: "Sign in", href: input.url },
    ),
  });
}

/** Escapes text for safe interpolation into the email HTML body. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Structured meeting summary the recipient email renders (subset of MeetingSummary). */
export type SummaryEmailContent = {
  summary: string | null;
  overview?: string | null;
  decisions?: string[] | null;
  actionItems?: Array<{ task: string; owner: string | null }> | null;
  topics?: string[] | null;
};

/**
 * Renders the summary sections as the email body's inner HTML, mirroring the
 * notebook's AI panels: mono-uppercase section labels (`ai / decisions`…),
 * decisions with a green check, action items as bordered cards with an owner
 * badge, and keywords as mono pills.
 */
function renderSummaryBody(content: SummaryEmailContent): string {
  const blocks: string[] = [];

  // Section label — matches the notebook panel headers (mono, uppercase, dot).
  const heading = (t: string) =>
    `<div style="font-family:${T.mono};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${T.muted};margin:22px 0 8px">` +
    `<span style="display:inline-block;width:5px;height:5px;border-radius:1px;background:${T.accent};vertical-align:middle;margin-right:6px"></span>${t}</div>`;

  const body = content.overview?.trim() || content.summary?.trim();
  if (body)
    blocks.push(
      `<p style="margin:0;font-size:14px;line-height:1.6;color:#333333">${esc(body)}</p>`,
    );

  if (content.decisions?.length) {
    blocks.push(heading("ai / decisions"));
    blocks.push(
      content.decisions
        .map(
          (d) =>
            `<div style="display:flex;gap:8px;border:1px solid ${T.border};border-radius:5px;padding:8px 10px;margin-bottom:6px;font-size:14px;line-height:1.5;color:${T.fg}">` +
            `<span style="color:${T.accent};font-weight:700">&#10003;</span><span>${esc(d)}</span></div>`,
        )
        .join(""),
    );
  }

  if (content.actionItems?.length) {
    blocks.push(heading("ai / action items"));
    blocks.push(
      content.actionItems
        .map(
          (a) =>
            `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid ${T.border};border-radius:5px;margin-bottom:6px"><tr>` +
            `<td style="padding:8px 10px;font-size:14px;line-height:1.5;color:${T.fg}">${esc(a.task)}</td>` +
            (a.owner
              ? `<td style="padding:8px 10px;text-align:right;white-space:nowrap"><span style="display:inline-block;background:${T.accentSoft};color:${T.accent};border-radius:4px;padding:2px 7px;font-family:${T.mono};font-size:10px">${esc(a.owner)}</span></td>`
              : "") +
            `</tr></table>`,
        )
        .join(""),
    );
  }

  if (content.topics?.length) {
    blocks.push(heading("ai / keywords"));
    blocks.push(
      `<div>${content.topics
        .map(
          (t) =>
            `<span style="display:inline-block;border:1px solid ${T.border};border-radius:5px;padding:2px 8px;margin:0 5px 5px 0;font-family:${T.mono};font-size:11px;color:${T.muted}">${esc(t)}</span>`,
        )
        .join("")}</div>`,
    );
  }

  return blocks.join("");
}

/**
 * "Someone shared meeting minutes with you" email — sent to an ARBITRARY
 * recipient chosen by the meeting owner (e.g. a manager who didn't attend).
 *
 * Transparency (anti-phishing): the subject and body name WHO shared it, so the
 * recipient sees a real person behind the send, not an anonymous blast. There is
 * no deep link into the app — the recipient may not have an account — only the
 * summary content itself.
 */
export async function emailMeetingSummaryToRecipient(input: {
  to: string;
  /** Display name of the owner who is sharing (falls back to their email). */
  senderName: string;
  /** Human title/label for the meeting (falls back to a generic label). */
  meetingTitle: string;
  content: SummaryEmailContent;
  /** Optional free-text note the sender added. */
  note?: string;
}): Promise<void> {
  const noteHtml = input.note?.trim()
    ? `<p style="margin:0 0 14px;padding:10px 12px;background:${T.frame};border-left:2px solid ${T.accent};border-radius:5px;font-style:italic;font-size:14px;color:#333333">${esc(input.note.trim())}</p>`
    : "";
  const intro = `<p style="margin:0 0 14px;font-size:14px;color:${T.muted}">${esc(input.senderName)} shared the minutes of <strong style="color:${T.fg}">${esc(input.meetingTitle)}</strong> with you via CasperAgent.</p>`;

  await sendEmail({
    to: input.to,
    subject: `${input.senderName} shared meeting minutes: ${input.meetingTitle}`,
    html: shell(
      "Meeting minutes",
      intro + noteHtml + renderSummaryBody(input.content),
    ),
  });
}
