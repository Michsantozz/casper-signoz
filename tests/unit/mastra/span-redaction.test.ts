import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isDroppedSpanType,
  redactSpanContent,
  withSpanContentRedaction,
} from "@/mastra/span-redaction";

/**
 * The SigNoz export edge must not carry model content.
 *
 * `@mastra/otel-exporter` copies a span's `input`/`output` onto OTLP attributes
 * unconditionally — verified against the shipped v1.2.4 (`getAttributes`):
 * `gen_ai.input.messages` / `gen_ai.output.messages` for model spans,
 * `gen_ai.tool.call.arguments` / `.result` for tool spans, and
 * `mastra.<span_type>.input` / `.output` for everything else, plus
 * `gen_ai.system_instructions` from `attributes.instructions`. For this app
 * that is meeting transcripts leaving a multi-tenant product in cleartext.
 * Mastra's default SensitiveDataFilter does not stop it: it matches sensitive
 * KEY NAMES, and a message body is a value.
 *
 * These tests pin the wrapper's contract, including the part that is easy to
 * regress silently: it must never mutate the span, because the same object is
 * handed to the storage and Langfuse exporters, which are meant to keep the
 * payload.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OTEL_CAPTURE_CONTENT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Minimal stand-in for the exporter interface the wrapper delegates to. */
function fakeExporter() {
  return {
    name: "otel",
    // Typed parameter, so the assertions below can read `mock.calls[0][0]`.
    exportTracingEvent: vi.fn(async (_event: unknown) => {}),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

const modelSpan = () => ({
  type: "model_generation",
  input: {
    messages: [{ role: "user", content: "transcript of the Q3 board meeting" }],
  },
  output: { text: "action items: renew the vendor contract" },
  attributes: { model: "kimi-k2p7-code", instructions: "You are Casper…" },
});

describe("redactSpanContent", () => {
  it("replaces payloads with a size marker and redacts instructions", () => {
    const span = modelSpan();
    const redacted = redactSpanContent(span);

    expect(redacted.input).toEqual({
      redacted: true,
      chars: JSON.stringify(span.input).length,
    });
    expect(redacted.output).toEqual({
      redacted: true,
      chars: JSON.stringify(span.output).length,
    });
    expect(redacted.attributes.instructions).toBe("[REDACTED]");
    // Non-content attributes are labels an operator reads — they stay.
    expect(redacted.attributes.model).toBe("kimi-k2p7-code");

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("board meeting");
    expect(serialized).not.toContain("vendor contract");
    expect(serialized).not.toContain("You are Casper");
  });

  it("keeps the ORIGINAL span intact (storage and Langfuse still get content)", () => {
    const span = modelSpan();
    redactSpanContent(span);

    expect(span.input).toEqual({
      messages: [
        { role: "user", content: "transcript of the Q3 board meeting" },
      ],
    });
    expect(span.output).toEqual({
      text: "action items: renew the vendor contract",
    });
    expect(span.attributes.instructions).toBe("You are Casper…");
  });

  it("preserves 'had input' vs 'had none' instead of deleting the field", () => {
    // A waterfall reads differently when a span had a payload but it was
    // stripped than when it never had one, so the marker stays present.
    const withEmpty = redactSpanContent({ type: "tool_call", input: "" });
    expect(withEmpty.input).toEqual({ redacted: true, chars: 0 });

    const withoutInput = { type: "tool_call", output: { ok: true } } as {
      type: string;
      input?: unknown;
      output?: unknown;
    };
    expect(redactSpanContent(withoutInput)).not.toHaveProperty("input");
  });

  it("survives a circular payload rather than throwing on the export path", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(redactSpanContent({ type: "agent_run", input: circular }).input).toEqual(
      { redacted: true, chars: -1 },
    );
  });

  it("returns the same object when there is nothing to redact", () => {
    const span = { type: "model_chunk", attributes: { index: 3 } };
    expect(redactSpanContent(span)).toBe(span);
  });
});

describe("withSpanContentRedaction", () => {
  it("redacts every span before it reaches the wrapped exporter", async () => {
    const exporter = fakeExporter();
    const wrapped = withSpanContentRedaction(
      exporter as unknown as Parameters<typeof withSpanContentRedaction>[0],
    );

    await wrapped.exportTracingEvent({
      type: "span_ended",
      exportedSpan: modelSpan(),
    } as never);

    expect(exporter.exportTracingEvent).toHaveBeenCalledTimes(1);
    const forwarded = JSON.stringify(
      exporter.exportTracingEvent.mock.calls[0]![0],
    );
    expect(forwarded).not.toContain("board meeting");
    expect(forwarded).toContain('"redacted":true');
  });

  it("drops model_chunk spans — one span per stream chunk, no value here", async () => {
    const exporter = fakeExporter();
    const wrapped = withSpanContentRedaction(
      exporter as unknown as Parameters<typeof withSpanContentRedaction>[0],
    );

    await wrapped.exportTracingEvent({
      type: "span_ended",
      exportedSpan: { type: "model_chunk", output: "tok" },
    } as never);

    expect(isDroppedSpanType("model_chunk")).toBe(true);
    expect(isDroppedSpanType("model_generation")).toBe(false);
    expect(exporter.exportTracingEvent).not.toHaveBeenCalled();
  });

  it("keeps payloads when OTEL_CAPTURE_CONTENT=1 (throwaway instance only)", async () => {
    process.env.OTEL_CAPTURE_CONTENT = "1";
    const exporter = fakeExporter();
    const wrapped = withSpanContentRedaction(
      exporter as unknown as Parameters<typeof withSpanContentRedaction>[0],
    );

    await wrapped.exportTracingEvent({
      type: "span_ended",
      exportedSpan: modelSpan(),
    } as never);

    expect(
      JSON.stringify(exporter.exportTracingEvent.mock.calls[0]![0]),
    ).toContain("board meeting");
  });

  it("delegates the rest of the exporter lifecycle untouched", async () => {
    const exporter = fakeExporter();
    const wrapped = withSpanContentRedaction(
      exporter as unknown as Parameters<typeof withSpanContentRedaction>[0],
    );

    expect(wrapped.name).toBe("otel");
    await wrapped.flush();
    await wrapped.shutdown();
    expect(exporter.flush).toHaveBeenCalledTimes(1);
    expect(exporter.shutdown).toHaveBeenCalledTimes(1);
  });
});
