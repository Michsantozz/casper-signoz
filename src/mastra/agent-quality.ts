import "server-only";

import { SpanKind } from "@opentelemetry/api";
import { createCompletenessScorer } from "@mastra/evals/scorers/prebuilt";
import { getSignozTracer } from "@/mastra/llm-telemetry";

/**
 * Agent RESPONSE-QUALITY telemetry — the third observability axis.
 *
 * Cost (gen_ai.usage.cost) and latency/errors (span duration + status) tell you
 * how much a turn cost and whether it broke. Neither tells you whether the
 * answer was any GOOD. This closes that gap: after each agent turn we run a
 * deterministic, zero-LLM quality scorer over (prompt → answer) and emit the
 * score as an OTLP span, so SigNoz can chart "agent answer quality over time"
 * and alert when it drops.
 *
 * The scorer is @mastra/evals' `completeness` (code/NLP, no judge model, no
 * tokens) — it measures how fully the answer covers the elements of the request.
 * This matches the project's "deterministic first, LLM only where needed"
 * philosophy: quality monitoring that costs nothing per turn.
 *
 * No-op when SigNoz is off (getSignozTracer() returns undefined). Best-effort:
 * a scoring failure never affects the actual response — it's pure side-effect.
 */

// Built once — the scorer is stateless and cheap to reuse.
const completenessScorer = createCompletenessScorer();

// Emit ONE span carrying the quality score. Backdated so its timestamp lines up
// with the turn it scored. mastra.span.type = "eval" is the discriminator the
// quality dashboard/alert filter on.
function emitEvalSpan(args: {
  scorer: string;
  score: number;
  durationMs: number;
}) {
  const tracer = getSignozTracer();
  if (!tracer) return;

  const span = tracer.startSpan(`eval ${args.scorer}`, {
    kind: SpanKind.INTERNAL,
    startTime: new Date(Date.now() - args.durationMs),
  });
  span.setAttribute("mastra.span.type", "eval");
  span.setAttribute("mastra.eval.scorer", args.scorer);
  // 0..1 quality score. One stable attribute name so the dashboard aggregates
  // avg/p05 across turns and the alert fires when it drops.
  span.setAttribute("mastra.eval.score", args.score);
  span.end();
}

/**
 * Score one agent turn's answer quality and ship it to SigNoz. `promptText` is
 * the user's request, `answerText` the agent's final reply. Fire-and-forget;
 * callers should not await it on the response hot path.
 */
export async function scoreAgentTurn(args: {
  promptText: string;
  answerText: string;
}): Promise<void> {
  // Skip empties — nothing to score, and the scorer would divide by zero.
  if (!args.promptText.trim() || !args.answerText.trim()) return;
  if (!getSignozTracer()) return; // no SigNoz → don't spend cycles scoring

  // Mastra message content is the V2 shape ({ format, parts }), not a bare
  // string — build a minimal text message for each side.
  const msg = (role: "user" | "assistant", text: string) => ({
    id: crypto.randomUUID(),
    createdAt: new Date(),
    role,
    content: { format: 2 as const, parts: [{ type: "text" as const, text }] },
  });

  const started = Date.now();
  try {
    const result = await completenessScorer.run({
      input: {
        inputMessages: [msg("user", args.promptText)],
        rememberedMessages: [],
        systemMessages: [],
        taggedSystemMessages: {},
      },
      output: [msg("assistant", args.answerText)],
    });
    const score = typeof result?.score === "number" ? result.score : undefined;
    if (score === undefined) return;
    emitEvalSpan({
      scorer: "completeness",
      score,
      durationMs: Date.now() - started,
    });
  } catch {
    // Quality scoring is best-effort — never let it surface to the user.
  }
}
