import "server-only";

import { SpanKind } from "@opentelemetry/api";
import { createCompletenessScorer } from "@mastra/evals/scorers/prebuilt";
import {
  getSignozTracer,
  currentTurnLink,
  parentContextFromLink,
} from "@/mastra/llm-telemetry";

/**
 * Agent answer-COVERAGE telemetry — the third observability axis.
 *
 * Cost (gen_ai.usage.cost) and latency/errors (span duration + status) tell you
 * how much a turn cost and whether it broke. Neither tells you anything about
 * the ANSWER. This closes part of that gap: after each agent turn we run a
 * deterministic, zero-LLM scorer over (prompt → answer) and emit the score as an
 * OTLP span, so SigNoz can chart it over time and alert when it drops.
 *
 * WHAT IT ACTUALLY MEASURES — and what it does not. The scorer is
 * @mastra/evals' `completeness` (code/NLP, no judge model, no tokens). Per its
 * own reference, it extracts elements from the INPUT (nouns, verbs, topics,
 * terms), then scores:
 *
 *     score = covered_elements / total_input_elements
 *
 * with an element counted as covered on substantial (>60%) string overlap. So
 * this is LEXICAL COVERAGE of the request — "did the answer engage with the
 * whole question" — NOT correctness and NOT quality. Two consequences worth
 * naming, because a panel labelled otherwise would mislead an operator:
 *   - a reply that parrots the prompt's vocabulary scores HIGH while saying
 *     nothing;
 *   - a correct, terse reply ("Yes — 3 failed.") can score LOW.
 *
 * So the dashboard panel and the alert are named "answer coverage", and both are
 * meant to be read as DROP DETECTORS against this service's own baseline: a step
 * down is real signal (a truncation cap, a degraded retrieval hop, a prompt or
 * model regression), the absolute level is not a grade. Judging correctness
 * would need an LLM judge scorer — deliberately out of scope here, since it
 * would put a paid model call on every turn.
 *
 * No-op when SigNoz is off (getSignozTracer() returns undefined). Best-effort:
 * a scoring failure never affects the actual response — it's pure side-effect.
 */

// Built once — the scorer is stateless and cheap to reuse.
const completenessScorer = createCompletenessScorer();

// Emit ONE span carrying the coverage score. Backdated so its timestamp lines up
// with the turn it scored. mastra.span.type = "eval" is the discriminator the
// coverage dashboard/alert filter on.
function emitEvalSpan(args: {
  scorer: string;
  score: number;
  durationMs: number;
}) {
  const tracer = getSignozTracer();
  if (!tracer) return;

  // Join the turn's trace so the score lands IN the same waterfall as the LLM /
  // tool spans it evaluates — click a slow/errored turn, see its coverage score
  // right there. The ref was captured while the agent was live (this runs in
  // after(), when Mastra's own span context is already gone). No ref → detached
  // root, same as before.
  const link = currentTurnLink();
  const parentCtx = link ? parentContextFromLink(link) : undefined;

  const span = tracer.startSpan(
    `eval ${args.scorer}`,
    {
      kind: SpanKind.INTERNAL,
      startTime: new Date(Date.now() - args.durationMs),
    },
    parentCtx,
  );
  span.setAttribute("mastra.span.type", "eval");
  span.setAttribute("mastra.eval.scorer", args.scorer);
  // 0..1 coverage score. One stable attribute name so the dashboard aggregates
  // avg/p05 across turns and the alert fires when it drops.
  span.setAttribute("mastra.eval.score", args.score);
  span.end();
}

/**
 * Score one agent turn's answer coverage and ship it to SigNoz. `promptText` is
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
