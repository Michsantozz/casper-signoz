import type { ObservabilityExporter } from "@mastra/core/observability";
import type { TracingEvent } from "@mastra/core/observability";

/**
 * Content redaction + noise filtering for the SigNoz export path ONLY.
 *
 * WHY THIS EXISTS: `@mastra/otel-exporter` copies a span's `input`/`output`
 * verbatim onto OTLP attributes, unconditionally and with no opt-out. Verified
 * against the shipped package (v1.2.4, `getAttributes` in dist/index.js):
 *
 *   span.input  → gen_ai.input.messages        (model_generation)
 *               → gen_ai.tool.call.arguments   (tool_call / mcp_tool_call)
 *               → mastra.<span_type>.input     (everything else)
 *   span.output → gen_ai.output.messages / gen_ai.tool.call.result /
 *                 mastra.<span_type>.output
 *   attributes.instructions → gen_ai.system_instructions
 *
 * For this app that is meeting transcripts, minutes, and calendar payloads
 * leaving a multi-tenant product in cleartext for an operations backend. The
 * `SensitiveDataFilter` Mastra applies by default does NOT stop it: it matches
 * on FIELD NAMES (password/token/secret/apikey/auth/credential), so a message
 * body — which is a value, not a sensitive key — passes through whole.
 *
 * WHY A WRAPPER AND NOT `spanOutputProcessors`: that config is per-Observability
 * -INSTANCE, so redacting there would also strip input/output from the storage
 * exporter (the app's own PG, same trust boundary, where the payload is wanted
 * for debugging and the feedback pipeline) and from Langfuse. SigNoz is an
 * additional, independent sink — the redaction belongs on that edge alone.
 *
 * Also drops the highest-volume/lowest-value span types on this edge (see
 * DROPPED_SPAN_TYPES) without touching what the other exporters receive.
 *
 * Escape hatch: OTEL_CAPTURE_CONTENT=1 keeps payloads (local debugging against
 * a throwaway SigNoz). Never set it against an instance holding real traffic.
 */

/** Span types dropped before they reach SigNoz. */
const DROPPED_SPAN_TYPES = new Set(["model_chunk"]);

/** Attributes whose VALUE is model-authored prose rather than a label. */
const CONTENT_ATTRIBUTES = ["instructions"] as const;

const REDACTED = "[REDACTED]";

function captureContent(): boolean {
  return process.env.OTEL_CAPTURE_CONTENT === "1";
}

/**
 * Replace a payload with a non-sensitive stand-in that preserves the one signal
 * worth keeping: how big it was. Emitting a marker rather than deleting the
 * field keeps "this span had input" distinguishable from "this span had none",
 * which matters when reading a waterfall.
 */
function redactPayload(value: unknown): { redacted: true; chars: number } {
  let chars = 0;
  try {
    chars =
      typeof value === "string" ? value.length : JSON.stringify(value).length;
  } catch {
    // Circular or otherwise unserializable — size is unknowable, not fatal.
    chars = -1;
  }
  return { redacted: true, chars };
}

type SpanLike = {
  type?: string;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
};

/**
 * Returns a redacted COPY. Never mutates: the same span object is handed to
 * every exporter, so mutating here would silently strip PG and Langfuse too —
 * the exact coupling this wrapper exists to avoid.
 */
export function redactSpanContent<T extends SpanLike>(span: T): T {
  const hasContentAttribute = CONTENT_ATTRIBUTES.some(
    (key) => span.attributes?.[key] !== undefined,
  );
  if (
    span.input === undefined &&
    span.output === undefined &&
    !hasContentAttribute
  ) {
    return span;
  }

  const next: T = { ...span };
  if (span.input !== undefined) next.input = redactPayload(span.input);
  if (span.output !== undefined) next.output = redactPayload(span.output);

  if (hasContentAttribute) {
    const attributes = { ...span.attributes };
    for (const key of CONTENT_ATTRIBUTES) {
      if (attributes[key] !== undefined) attributes[key] = REDACTED;
    }
    next.attributes = attributes;
  }

  return next;
}

/** True when this span type is dropped before reaching SigNoz. */
export function isDroppedSpanType(type: string | undefined): boolean {
  return type !== undefined && DROPPED_SPAN_TYPES.has(type);
}

type TracingEventLike = { exportedSpan?: SpanLike };

/**
 * Apply the edge policy to one tracing event: drop it entirely (noise) or
 * return an event carrying a redacted span. `null` means "do not export".
 */
function processEvent<E extends TracingEventLike>(event: E): E | null {
  const span = event?.exportedSpan;
  if (!span) return event;
  if (isDroppedSpanType(span.type)) return null;
  if (captureContent()) return event;
  return { ...event, exportedSpan: redactSpanContent(span) };
}

/**
 * Wrap an exporter so every span crossing it is redacted and noise-filtered.
 * Delegates everything else untouched, so the wrapped exporter keeps its own
 * lifecycle (init/flush/shutdown) and any optional handler it implements.
 */
export function withSpanContentRedaction<T extends ObservabilityExporter>(
  exporter: T,
): T {
  const wrapped = Object.create(exporter) as T;

  wrapped.exportTracingEvent = async (event: TracingEvent) => {
    const next = processEvent(event as TracingEventLike);
    if (!next) return;
    return exporter.exportTracingEvent(next as TracingEvent);
  };

  if (typeof exporter.onTracingEvent === "function") {
    wrapped.onTracingEvent = (event: TracingEvent) => {
      const next = processEvent(event as TracingEventLike);
      if (!next) return;
      return exporter.onTracingEvent!(next as TracingEvent);
    };
  }

  return wrapped;
}
