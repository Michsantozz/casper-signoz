// Records a real Casper Agent session to a .webm for the Remotion demo.
// Drives the LIVE app (localhost:3009) with Playwright, video ON. It reuses the
// logged-in Playwright-MCP session (msantoznunes, calendar connected) by cloning
// its persistent profile, so no credentials live in this file.
//
//   node scripts/record-demo.mjs        (or: pnpm remotion:demo)
//
// Flow (all UI in English):
//   1. Meeting notebook tour — the GitLab "Weekly engineering sync": transcript,
//      summary, key moments, team dynamics, talk-time. Smooth auto-scroll.
//   2. Analyze tension — WebCodecs pass in the browser tags tense/quiet moments.
//   3. Home chat — ask the agent to email the minutes; the confirm card appears
//      and we click Send (the email tool is only registered on the home chat).
//
// Output: scripts/.demo-out/casper-session.webm

import { chromium } from "playwright";
import { mkdir, readdir, rename, cp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_URL = process.env.DEMO_URL ?? "http://localhost:3009";
const OUT_DIR = join(__dirname, ".demo-out");
const GITLAB_MEETING = "/meetings/demo-notebook-0001";

const MCP_PROFILE =
  process.env.DEMO_PROFILE ??
  join(homedir(), ".cache/ms-playwright-mcp/mcp-chrome-d681051");
const PROFILE_COPY = join(tmpdir(), "casper-demo-profile");

const VIEWPORT = { width: 1920, height: 1080 };

// The notebook is a 3-column layout where each column has its OWN internal
// scroller (the window itself never scrolls — window.scrollTo is a no-op here).
// The rich content (summary → sections → decisions → key moments → team
// dynamics → talk-time → analyze-tension) lives in the MIDDLE column, an
// <aside class="overflow-y-auto"> around x≈800. We scroll THAT element.
const MID_COLUMN_SELECTOR =
  'aside.overflow-y-auto'; // the middle scroller (summary/dynamics/tension)

/** Smoothly scroll the notebook's middle column to an absolute scrollTop. */
async function smoothScrollMid(page, targetTop, steps = 48, holdMs = 34) {
  const startTop = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollTop : 0;
  }, MID_COLUMN_SELECTOR);
  for (let i = 1; i <= steps; i++) {
    // ease-in-out so the motion feels intentional, not linear/robotic.
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const top = startTop + (targetTop - startTop) * eased;
    await page.evaluate(
      ({ sel, top }) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = top;
      },
      { sel: MID_COLUMN_SELECTOR, top },
    );
    await page.waitForTimeout(holdMs);
  }
}

/** How far the middle column can scroll (scrollHeight - clientHeight). */
async function midScrollRange(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  }, MID_COLUMN_SELECTOR);
}

/**
 * Inject CSS that hides dev-only chrome for a clean home-chat shot:
 *  - the "Conversations" sidebar (littered with test chats)
 *  - the calendar "Connected · <email> / Disconnect" header (leaks the account)
 * Kept as a <style> so it survives re-renders within the SPA.
 */
async function cleanChrome(page) {
  await page.evaluate(() => {
    let st = document.getElementById("demo-clean");
    if (!st) {
      st = document.createElement("style");
      st.id = "demo-clean";
      document.head.appendChild(st);
    }
    st.textContent = `
      aside.w-64 { display: none !important; }
      [data-demo-hide="1"] { display: none !important; }
    `;
    // Tag the calendar header (a <header> containing the Disconnect control).
    const hdr = [...document.querySelectorAll("header")].find((h) =>
      /Disconnect/.test(h.textContent || ""),
    );
    if (hdr) hdr.setAttribute("data-demo-hide", "1");
  });
}

/** Wait for the agent's streaming answer to settle. */
async function waitForAnswer(page, timeoutMs = 40000) {
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  await stop.waitFor({ state: "hidden", timeout: timeoutMs }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function ask(page, text) {
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.click();
  await input.pressSequentially(text, { delay: 16 });
  await page.waitForTimeout(400);
  await input.press("Enter");
  await waitForAnswer(page);
}

// Credentials for the demo account. Passed via env so nothing is committed —
// no fallback: set DEMO_EMAIL / DEMO_PASSWORD before running.
const DEMO_EMAIL = process.env.DEMO_EMAIL;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_EMAIL || !DEMO_PASSWORD) {
  throw new Error(
    "Set DEMO_EMAIL and DEMO_PASSWORD env vars before running record-demo.mjs",
  );
}

/**
 * Ensure the browser context has an authenticated session. The app gates the
 * home chat behind sign-in, so we log in through the password form once. Uses
 * the app's own /api/auth endpoint via the page's request context first (fast,
 * shares the cookie jar); falls back to driving the sign-in form if needed.
 */
async function ensureLoggedIn(context, page) {
  // Fast path: hit the better-auth email sign-in endpoint through the browser's
  // request context so the Set-Cookie lands in the shared jar.
  const res = await context.request
    .post(`${APP_URL}/api/auth/sign-in/email`, {
      data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      headers: { "Content-Type": "application/json" },
    })
    .catch(() => null);
  if (res && res.ok()) {
    console.log("→ signed in (api)");
    return;
  }

  // Fallback: drive the sign-in form.
  console.log("→ signing in (form)");
  await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  const email = page.getByRole("textbox", { name: /email/i }).first();
  const pass = page.locator('input[type="password"]').first();
  if (await email.count()) {
    await email.click();
    await email.pressSequentially(DEMO_EMAIL, { delay: 12 });
    await pass.click();
    await pass.pressSequentially(DEMO_PASSWORD, { delay: 12 });
    await page.getByRole("button", { name: /sign in|log in|continue/i }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
  }
}

async function dismissOnboarding(page) {
  const heading = page.getByText("Welcome to Casper Agent");
  await heading.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await heading.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Get started" }).click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    if (await heading.isVisible().catch(() => false)) await page.keyboard.press("Escape");
    await heading.waitFor({ state: "hidden", timeout: 6000 }).catch(() => {});
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await rm(PROFILE_COPY, { recursive: true, force: true });
  await cp(MCP_PROFILE, PROFILE_COPY, {
    recursive: true,
    filter: (src) => !/\/(Singleton|lockfile|\.lock)/.test(src),
  }).catch((e) => console.warn("  (partial copy)", e.message));

  const context = await chromium.launchPersistentContext(PROFILE_COPY, {
    headless: true,
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
    deviceScaleFactor: 1,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Make sure we have an authenticated session (the home chat is gated).
  await ensureLoggedIn(context, page);

  /* ── Part 1: the meeting notebook ─────────────────────────────────── */
  console.log("→ open notebook");
  await page.goto(`${APP_URL}${GITLAB_MEETING}`, { waitUntil: "networkidle" });
  await dismissOnboarding(page);
  await page.waitForTimeout(2500); // hold on the header + player + transcript

  console.log("→ tour: scroll the middle column (summary → sections → dynamics)");
  // The middle column carries the rich AI output: summary, sections, decisions,
  // key moments, soundbites, team dynamics and talk-time. Walk down it in eased
  // steps, lingering at each band so the footage reads as a guided tour — not
  // an idle scroll. Stops are computed as fractions of the real scroll range so
  // the tour adapts if the content height changes.
  const range = await midScrollRange(page);
  const fractions = [0.16, 0.34, 0.52, 0.7, 0.86, 1.0];
  for (const f of fractions) {
    await smoothScrollMid(page, Math.round(range * f), 46, 30);
    await page.waitForTimeout(1500);
  }

  /* ── Part 2: analyze tension ──────────────────────────────────────── */
  // The analyze-tension button sits at the bottom of the middle column, which
  // we've now scrolled to. Clicking it runs a WebCodecs pass that tags the
  // meeting's tense (🔥) and quiet (🔇) moments right in place.
  console.log("→ analyze tension");
  const tension = page.getByRole("button", { name: /analyze tension/i });
  if (await tension.count()) {
    await tension.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await tension.click();
    // WebCodecs pass runs in-browser; wait for the "re-analyze" swap.
    await page.getByRole("button", { name: /re-analyze/i }).waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // Scroll up a touch so the freshly-tagged 🔥/🔇 moments are on screen.
    await smoothScrollMid(page, Math.round((await midScrollRange(page)) * 0.72), 30, 30);
    await page.waitForTimeout(2500); // hold on the tagged moments
  } else {
    console.warn("  analyze-tension button not found (already analyzed?)");
    await page.waitForTimeout(1500);
  }

  /* ── Part 3: home chat → email the minutes ────────────────────────── */
  console.log("→ home chat: email the minutes");
  await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
  await dismissOnboarding(page);
  // Start a fresh, empty chat FIRST (the "new chat" button lives in the sidebar,
  // which we're about to hide), then hide the conversations sidebar + calendar
  // 'Connected/Disconnect' header so the email flow reads clean and doesn't leak
  // the account in the recording.
  await page.getByRole("button", { name: "new chat", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await cleanChrome(page);
  await page.waitForTimeout(500);
  await page.getByRole("textbox", { name: "Message input" }).waitFor({ state: "visible", timeout: 15000 });

  await ask(
    page,
    'Email the minutes of the "Weekly engineering sync" to my manager at manager@example.com',
  );
  await cleanChrome(page); // re-assert hide (SPA may have re-mounted the header)

  // Fill the confirm card and send it.
  const recipient = page.getByRole("textbox", { name: "recipient" });
  if (await recipient.count()) {
    await recipient.click();
    await recipient.pressSequentially("manager@example.com", { delay: 24 });
    const note = page.getByRole("textbox", { name: /note/i });
    if (await note.count()) {
      await note.click();
      await note.pressSequentially("Minutes from today's sync — owners and decisions inside.", { delay: 14 });
    }
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Send", exact: true }).click().catch(() => {});
    await waitForAnswer(page);
  } else {
    console.warn("  email confirm card not found");
  }

  // Hold the final frame so the video doesn't cut abruptly.
  await page.waitForTimeout(3000);

  await context.close();

  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith(".webm") && f.startsWith("page"));
  const latest = files.sort().at(-1);
  if (!latest) throw new Error("no video produced");
  const finalPath = join(OUT_DIR, "casper-session.webm");
  await rename(join(OUT_DIR, latest), finalPath);
  console.log("✓ recorded", finalPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
