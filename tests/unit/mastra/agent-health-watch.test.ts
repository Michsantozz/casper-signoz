import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The autonomous agent-health watch — core logic (server/observability/
 * agent-health-watch.ts) + its cron step + its manual trigger route.
 *
 * runAgentHealthWatch drives the sreAgent with a "watch yourself" prompt and
 * fans the summary out as an operator notification. Contract we lock in:
 *  - agent not registered → { ran:false }, NO notifications (fail-safe no-op);
 *  - empty agent output → a fallback summary string, never an empty bell;
 *  - notify:false → returns the summary but fans out to NOBODY (dry demo run);
 *  - notify (default) → one notification PER user, type agent_health_alert,
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
const userRows: { id: string }[] = [];
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
  // Default: agent present, two operators, a normal summary.
  getAgentById.mockReturnValue({ generate });
  generate.mockResolvedValue({ text: "All healthy. No alert needed." });
  userRows.push({ id: "u1" }, { id: "u2" });
});

describe("runAgentHealthWatch — no-op paths", () => {
  it("returns ran:false and notifies nobody when sreAgent is not registered", async () => {
    getAgentById.mockReturnValue(undefined);
    const out = await run();
    expect(out).toEqual({
      ran: false,
      summary: "sreAgent not registered",
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
    userRows.length = 0;
    const out = await run();
    expect(out.ran).toBe(true);
    expect(out.notified).toBe(0);
    expect(createNotificationsForUsers).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: [] }),
    );
  });
});
