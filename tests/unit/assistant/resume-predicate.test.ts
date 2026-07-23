import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import {
  shouldResumeAfterClientTool,
  CLIENT_TOOLS,
} from "@/features/assistant/model/resume-predicate";

/**
 * shouldResumeAfterClientTool — the auto-resume predicate for assistant-ui.
 *
 * This is the fix for the infinite chat loop: the stock predicate
 * (lastAssistantMessageIsCompleteWithToolCalls) resent the whole turn after ANY
 * completed tool call, including the agent's SERVER tools, which made Mastra
 * re-run the turn forever (N identical answers, N POSTs to /api/chat). The
 * predicate must resume ONLY after a genuine CLIENT tool (pick_date /
 * connect_calendar / confirm_send_summary_email) resolves.
 *
 * Part shapes mirror AI SDK v6 UIMessage tool parts: type `tool-<name>` with a
 * `state` of "output-available" once complete. We build minimal messages.
 */

type Part = UIMessage["parts"][number];

function toolPart(name: string, state: string): Part {
  return {
    type: `tool-${name}`,
    toolCallId: `${name}-1`,
    state,
    input: {},
    output: {},
  } as unknown as Part;
}

function assistantMessage(parts: Part[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as UIMessage;
}

const stepStart = { type: "step-start" } as unknown as Part;
const text = (t: string) => ({ type: "text", text: t }) as unknown as Part;

describe("shouldResumeAfterClientTool", () => {
  it("resumes after a completed CLIENT tool (pick_date)", () => {
    const messages = [
      assistantMessage([toolPart("pick_date", "output-available")]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(true);
  });

  it("does NOT resume after a completed SERVER tool (the loop bug)", () => {
    // searchAgent / updateWorkingMemory arrive already-executed with a result but
    // are not client tools — the stock predicate resumed here and looped.
    const messages = [
      assistantMessage([toolPart("agent-searchAgent", "output-available")]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does NOT resume for updateWorkingMemory", () => {
    const messages = [
      assistantMessage([toolPart("updateWorkingMemory", "output-available")]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does NOT resume when the last step mixes a client and a server tool", () => {
    const messages = [
      assistantMessage([
        toolPart("pick_date", "output-available"),
        toolPart("agent-minutesAgent", "output-available"),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does NOT resume while a client tool is still pending (not complete)", () => {
    const messages = [
      assistantMessage([toolPart("pick_date", "input-available")]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("resumes on output-error of a client tool (terminal state)", () => {
    const messages = [
      assistantMessage([toolPart("connect_calendar", "output-error")]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(true);
  });

  it("does NOT resume once the agent already answered in the same step (loop fix)", () => {
    // The observed loop: the agent's answer text lands in the SAME step as the
    // resolved client tool (no fresh step-start), so the client tool stays the
    // only tool part and the stock check keeps firing a resend every render.
    // A non-empty text part after the resolved client tool means the agent has
    // responded — do NOT resend again.
    const messages = [
      assistantMessage([
        toolPart("pick_date", "output-available"),
        text("You picked July 15 at 09:00. Want to book it?"),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does NOT resume when text keeps stacking after the client tool", () => {
    // Second/third spurious resend: parts grow with extra text each time.
    const messages = [
      assistantMessage([
        toolPart("pick_date", "output-available"),
        text("You picked July 15 at 09:00."),
        text("You picked July 15 at 09:00."),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("still resumes when the step is just the resolved client tool (no answer yet)", () => {
    // The one genuine resume moment: user acted, agent hasn't responded.
    const messages = [
      assistantMessage([
        stepStart,
        toolPart("connect_calendar", "output-available"),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(true);
  });

  it("ignores an empty/whitespace text part (still resumes)", () => {
    const messages = [
      assistantMessage([
        toolPart("pick_date", "output-available"),
        text("   "),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(true);
  });

  it("only considers the LAST step's tool parts", () => {
    // A server tool in an earlier step, then a fresh step with a client tool:
    // the earlier server tool must not block the resume.
    const messages = [
      assistantMessage([
        stepStart,
        toolPart("agent-searchAgent", "output-available"),
        stepStart,
        toolPart("pick_date", "output-available"),
      ]),
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(true);
  });

  it("does not resume when the last step has no tool parts", () => {
    const messages = [assistantMessage([text("here you go")])];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does not resume when the last message is not an assistant message", () => {
    const messages = [
      { id: "u1", role: "user", parts: [text("hi")] } as UIMessage,
    ];
    expect(shouldResumeAfterClientTool({ messages })).toBe(false);
  });

  it("does not resume for an empty message list", () => {
    expect(shouldResumeAfterClientTool({ messages: [] })).toBe(false);
  });

  it("CLIENT_TOOLS holds exactly the three human-in-the-loop tools", () => {
    expect([...CLIENT_TOOLS].sort()).toEqual([
      "confirm_send_summary_email",
      "connect_calendar",
      "pick_date",
    ]);
  });
});
