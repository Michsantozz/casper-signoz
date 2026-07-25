import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgentById = vi.fn();
const generate = vi.fn();
const createNotificationsForUsers = vi.fn();
const userRows: { id: string; email: string }[] = [];

vi.mock("@/shared/db", () => ({
  db: {
    select: () => ({ from: () => Promise.resolve(userRows) }),
  },
}));
vi.mock("@/shared/db/auth-schema", () => ({ user: {} }));
vi.mock("@/server/notifications", () => ({
  createNotificationsForUsers: (...args: unknown[]) =>
    createNotificationsForUsers(...args),
}));
vi.mock("@/mastra", () => ({
  mastra: { getAgentById: (...args: unknown[]) => getAgentById(...args) },
}));

async function run(opts?: { notify?: boolean }) {
  const { runAgentReliabilityReport } = await import(
    "@/server/observability/agent-reliability-report"
  );
  return runAgentReliabilityReport(opts);
}

beforeEach(() => {
  vi.resetModules();
  getAgentById.mockReset();
  generate.mockReset();
  createNotificationsForUsers.mockReset();
  userRows.length = 0;
  process.env.OPERATOR_USER_IDS = "op-1";
  delete process.env.OPERATOR_EMAILS;
  getAgentById.mockReturnValue({ generate });
  generate.mockResolvedValue({ text: "  Reliability held steady.  " });
  userRows.push(
    { id: "op-1", email: "op@example.com" },
    { id: "user-1", email: "user@example.com" },
  );
});

describe("runAgentReliabilityReport", () => {
  it("passes an AbortSignal and uses the read-only SRE agent", async () => {
    const out = await run({ notify: false });

    expect(out).toEqual({
      ran: true,
      summary: "Reliability held steady.",
      notified: 0,
    });
    expect(getAgentById).toHaveBeenCalledWith("sreAgent");
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("notifies only explicitly configured operators", async () => {
    const out = await run();

    expect(out.notified).toBe(1);
    expect(createNotificationsForUsers).toHaveBeenCalledWith({
      userIds: ["op-1"],
      type: "agent_reliability_report",
      message: "Reliability held steady.",
    });
  });

  it("aborts a timed-out generation so no later work can continue", async () => {
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
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    const out = await pending;
    vi.useRealTimers();

    expect(out.ran).toBe(false);
    expect(out.summary).toContain("ReportTimeoutError");
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toMatchObject({
      name: "ReportTimeoutError",
    });
  });
});
