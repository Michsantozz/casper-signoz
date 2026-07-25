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

  it("hands the agent both window boundaries as epoch ms, anchored to now", async () => {
    // The model has no clock. Asked for "the prior 7 days" it writes absolute
    // timestamps out of its training prior and gets the YEAR wrong — observed
    // live on 2026-07-25, it queried 2025-06-30 → 2025-07-07. Those queries
    // SUCCEED and scan zero rows, so the digest reports "prior window empty"
    // and silently degrades to a current-only snapshot every single week.
    // Compute the bounds here and pin that they reach the prompt.
    const before = Date.now();
    await run({ notify: false });
    const after = Date.now();

    const prompt = generate.mock.calls[0]![0] as string;
    const bounds = [...prompt.matchAll(/(?:start|end)=(\d{13})\b/g)].map((m) =>
      Number(m[1]),
    );
    expect(bounds.length, "prompt must carry both windows").toBe(4);

    const day = 86_400_000;
    for (const ms of bounds) {
      // Every bound sits inside [now-14d, now] — the check that would have
      // caught the year being wrong.
      expect(ms).toBeGreaterThanOrEqual(before - 14 * day - 1000);
      expect(ms).toBeLessThanOrEqual(after + 1000);
    }
    const [currentStart, currentEnd, priorStart, priorEnd] = bounds as [
      number,
      number,
      number,
      number,
    ];
    // Contiguous and equal-length: a shorter prior window manufactures a
    // regression out of nothing, which step 3 then ranks as the worst one.
    expect(priorEnd).toBe(currentStart);
    expect(currentEnd - currentStart).toBe(7 * day);
    expect(priorEnd - priorStart).toBe(7 * day);
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
