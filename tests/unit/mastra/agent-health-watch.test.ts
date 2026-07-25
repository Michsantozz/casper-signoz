import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The autonomous agent-health watch — core logic (server/observability/
 * agent-health-watch.ts) + its cron step + its manual trigger route.
 *
 * runAgentHealthWatch drives the internal sreAutomationAgent with a "watch
 * yourself" prompt and
 * fans the summary out as an operator notification. Contract we lock in:
 *  - agent not registered → { ran:false }, NO notifications (fail-safe no-op);
 *  - empty agent output → a fallback summary string, never an empty bell;
 *  - notify:false → returns the summary but fans out to NOBODY (dry demo run);
 *  - notify (default) → one notification per configured operator,
 *    message truncated to 500 chars (it's a bell-icon blurb, not a report);
 *  - the summary is trimmed.
 *
 * The @/mastra barrel (dynamically imported), the db user query, and the
 * notification fan-out are all mocked — this is the step logic in isolation, no
 * LLM, no PG.
 */

const getAgentById = vi.fn();
const generate = vi.fn();
const createNotificationsForUsers = vi.fn();

// db.select(...).from(user) → resolves the operator rows. Chainable thenable.
const userRows: { id: string; email: string }[] = [];
vi.mock("@/shared/db", () => ({
  db: {
    select: () => ({ from: () => Promise.resolve(userRows) }),
  },
}));
vi.mock("@/shared/db/auth-schema", () => ({ user: {} }));
vi.mock("@/server/notifications", () => ({
  createNotificationsForUsers: (...a: unknown[]) =>
    createNotificationsForUsers(...a),
}));
vi.mock("@/mastra", () => ({
  mastra: { getAgentById: (...a: unknown[]) => getAgentById(...a) },
}));

async function run(opts?: { notify?: boolean }) {
  const { runAgentHealthWatch } = await import(
    "@/server/observability/agent-health-watch"
  );
  return runAgentHealthWatch(opts);
}

beforeEach(() => {
  vi.resetModules();
  getAgentById.mockReset();
  generate.mockReset();
  createNotificationsForUsers.mockReset();
  userRows.length = 0;
  process.env.OPERATOR_USER_IDS = "u1,u2";
  delete process.env.OPERATOR_EMAILS;
  // Default: agent present, two operators, a normal summary.
  getAgentById.mockReturnValue({ generate });
  generate.mockResolvedValue({ text: "All healthy. No alert needed." });
  userRows.push(
    { id: "u1", email: "u1@example.com" },
    { id: "u2", email: "u2@example.com" },
  );
});

describe("runAgentHealthWatch — no-op paths", () => {
  it("returns ran:false when the automation agent is not registered", async () => {
    getAgentById.mockReturnValue(undefined);
    const out = await run();
    expect(out).toEqual({
      ran: false,
      summary: "sreAutomationAgent not registered",
      notified: 0,
    });
    expect(createNotificationsForUsers).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to a non-empty summary when the agent returns empty text", async () => {
    generate.mockResolvedValue({ text: "   " });
    const out = await run({ notify: false });
    expect(out.summary).toBe("Health check produced no output.");
  });

  it("falls back when generate returns no text field at all", async () => {
    generate.mockResolvedValue({});
    const out = await run({ notify: false });
    expect(out.summary).toBe("Health check produced no output.");
  });
});

describe("runAgentHealthWatch — notify:false (dry run)", () => {
  it("returns the trimmed summary but fans out to nobody", async () => {
    generate.mockResolvedValue({ text: "  cost is flat  " });
    const out = await run({ notify: false });
    expect(out).toEqual({ ran: true, summary: "cost is flat", notified: 0 });
    expect(createNotificationsForUsers).not.toHaveBeenCalled();
    expect(getAgentById).toHaveBeenCalledWith("sreAutomationAgent");
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });
});

describe("runAgentHealthWatch — fan-out", () => {
  it("notifies every operator with type agent_health_alert (default notify)", async () => {
    generate.mockResolvedValue({ text: "Tool foo failing; created alert." });
    const out = await run();

    expect(out).toEqual({
      ran: true,
      summary: "Tool foo failing; created alert.",
      notified: 2,
    });
    expect(createNotificationsForUsers).toHaveBeenCalledWith({
      userIds: ["u1", "u2"],
      type: "agent_health_alert",
      message: "Tool foo failing; created alert.",
    });
  });

  it("truncates the notification message to 500 chars", async () => {
    const long = "x".repeat(900);
    generate.mockResolvedValue({ text: long });
    await run();
    const arg = createNotificationsForUsers.mock.calls[0][0] as {
      message: string;
    };
    expect(arg.message).toHaveLength(500);
  });

  it("reports notified:0 when there are no operators, but still ran", async () => {
    process.env.OPERATOR_USER_IDS = "someone-else";
    const out = await run();
    expect(out.ran).toBe(true);
    expect(out.notified).toBe(0);
    expect(createNotificationsForUsers).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [] }),
    );
  });
});

// ── Failure containment ─────────────────────────────────────────────────────
//
// This runs on a */15 cron with concurrency:1. If the agent run throws, the
// Inngest step dies and the tick produces NOTHING — the health watch goes silent
// at exactly the moment the stack is unhealthy. Worse, if it HANGS it holds the
// only concurrency slot and every later tick is skipped too. Both are contained:
// the failure becomes a notification (broken silence) and `ran:false` (never
// reads as a passing check).

describe("runAgentHealthWatch — failure containment", () => {
  it("does not throw when the agent run rejects, and reports ran:false", async () => {
    generate.mockRejectedValue(new Error("MCP unreachable"));
    const out = await run({ notify: false });
    expect(out.ran).toBe(false);
    expect(out.summary).toContain("FAILED");
    expect(out.summary).toContain("MCP unreachable");
  });

  it("still notifies operators when the check fails (breaks the silence)", async () => {
    generate.mockRejectedValue(new Error("MCP unreachable"));
    const out = await run();
    expect(out.notified).toBe(2);
    expect(createNotificationsForUsers).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_health_alert" }),
    );
  });

  it("times out a hung agent run instead of holding the cron slot forever", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    generate.mockImplementation(
      (_prompt: string, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          receivedSignal = options?.abortSignal;
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        }),
    );
    const pending = run({ notify: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    const out = await pending;
    vi.useRealTimers();

    expect(out.ran).toBe(false);
    expect(out.summary).toContain("WatchTimeoutError");
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toMatchObject({
      name: "WatchTimeoutError",
    });
  });
});
