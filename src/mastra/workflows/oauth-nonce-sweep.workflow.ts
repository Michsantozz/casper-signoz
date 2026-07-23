import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * OAuth-nonce sweep (housekeeping).
 *
 * consumeOAuthNonce inserts one row per calendar-OAuth callback to make each
 * signed `state` single-use. Once a nonce's 10-min TTL passes its replay window
 * is closed and the row is dead weight — but nothing deletes it, so the table
 * grows unbounded. This cron reclaims the expired rows.
 *
 * Runs hourly: nonces live 10 min, so an hourly sweep keeps the table tiny
 * without competing with the busier meeting crons. Idempotent (a no-op when
 * there's nothing expired) and safe under concurrency (DELETE … WHERE expired).
 */
// Exported for unit-testing the step logic in isolation.
export const oauthNonceSweep = createStep({
  id: "oauth-nonce-sweep",
  inputSchema: z.object({}),
  outputSchema: z.object({ deleted: z.number() }),
  execute: async () => {
    const { sweepExpiredOAuthNonces } = await import(
      "@/server/recall/oauth-state"
    );
    const deleted = await sweepExpiredOAuthNonces();
    return { deleted };
  },
});

export const oauthNonceSweepWorkflow = createWorkflow({
  id: "oauth-nonce-sweep",
  inputSchema: z.object({}),
  outputSchema: z.object({ deleted: z.number() }),
  // Mastra-inngest cron contract: declare steps AND a static inputData so the
  // scheduled run validates (see meeting-reconcile.workflow.ts for the why).
  steps: [oauthNonceSweep],
  inputData: {},
  cron: "0 * * * *",
  concurrency: { limit: 1 },
  options: { validateInputs: false },
}).then(oauthNonceSweep);

oauthNonceSweepWorkflow.commit();
