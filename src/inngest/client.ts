import { Inngest } from "inngest";
import { init } from "@mastra/inngest";

// Inngest client — orchestrates the meeting workflows' scheduled crons.
// In dev: points to the local inngest-cli (pnpm dev:inngest).
//
// `isDev` fails CLOSED: an explicit INNGEST_DEV wins, but when it's unset we
// derive from NODE_ENV so a production deploy that forgot the var runs in
// production mode (using the signing keys) instead of silently in dev mode.
const isDev =
  process.env.INNGEST_DEV !== undefined
    ? process.env.INNGEST_DEV === "true"
    : process.env.NODE_ENV !== "production";

export const inngest = new Inngest({
  id: "casperagent",
  baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
  isDev,
});

// init() returns cron-aware createWorkflow/createStep bound to this Inngest.
// Use THESE (not the ones from @mastra/core) in workflows that run on a schedule.
export const { createWorkflow, createStep } = init(inngest);
