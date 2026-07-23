import { chromium } from "playwright";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

const baseURL = process.env.BASE_URL ?? "http://localhost:3009";
const outDir = process.env.VIDEO_DIR ?? "videos";
const email = process.env.DEMO_EMAIL ?? `demo+${Date.now()}@casperagent.local`;
const password = process.env.DEMO_PASSWORD ?? "CasperAgent-demo-2026!";

const prompt = [
  "Run a real demo for the pitch:",
  "1. Use get_mock_meeting with demoId demo-q3.",
  "2. Notarize that meeting on Casper Testnet.",
  "3. Verify the notarization with the same record.",
  "4. Reply with a short pitch-ready summary plus the meetingHash, transactionHash, and explorerUrl.",
].join("\n");

async function main() {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: outDir,
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: `
      [aria-label="Open Next.js Dev Tools"],
      [aria-label="Open issues overlay"],
      [aria-label="Collapse issues badge"] { display: none !important; }
    `,
  });

  await page.getByRole("button", { name: "Password" }).click();
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByPlaceholder("Your name").waitFor();
  await page.getByPlaceholder("Your name").fill("CasperAgent Demo");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();

  await page.getByText("How can I help on-chain today?").waitFor({
    timeout: 90_000,
  });

  const getStarted = page.getByRole("button", { name: "Get started" });
  if (
    await getStarted
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await getStarted.click();
    await getStarted.waitFor({ state: "hidden", timeout: 15_000 });
  }

  await page.waitForTimeout(1200);
  await page.getByLabel("Message input").fill(prompt);
  await page.waitForTimeout(600);
  await page.getByLabel("Send message").click();

  await page
    .getByText(/testnet\.cspr\.live\/deploy\/[0-9a-f]/i)
    .waitFor({ timeout: 240_000 });

  await page.waitForTimeout(12_000);

  const video = page.video();
  await context.close();
  await browser.close();

  const rawPath = await video.path();
  const finalPath = path.join(outDir, "casperagent-real-pitch.webm");
  await rename(rawPath, finalPath);

  console.log(JSON.stringify({ email, video: finalPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
