import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * TeamTrends — the /meetings/trends page. Contract by data state:
 *  - isLoading → loading frame;
 *  - isError → error frame;
 *  - available=false → empty state, shows the meetings-so-far count;
 *  - available with trends → header count, actionable signals, participant rows.
 *
 * useTeamTrends is mocked to drive each state; we assert the rendered output.
 */
const useTeamTrends = vi.fn();
vi.mock("@/features/meetings/model/queries", () => ({
  useTeamTrends: () => useTeamTrends(),
}));

async function renderTrends() {
  const { TeamTrends } = await import("@/features/meetings/ui/TeamTrends");
  return render(<TeamTrends />);
}

beforeEach(() => vi.clearAllMocks());

describe("TeamTrends", () => {
  it("shows a loading frame while fetching", async () => {
    useTeamTrends.mockReturnValue({ isLoading: true });
    await renderTrends();
    expect(screen.getByText(/loading team trends/i)).toBeInTheDocument();
  });

  it("shows an error frame on failure", async () => {
    useTeamTrends.mockReturnValue({ isError: true });
    await renderTrends();
    expect(screen.getByText(/couldn.t load team trends/i)).toBeInTheDocument();
  });

  it("shows the empty state with the meetings-so-far count", async () => {
    useTeamTrends.mockReturnValue({
      data: { available: false, meetingsWithDynamics: 2, trends: null },
    });
    await renderTrends();
    expect(screen.getByText(/not enough analyzed meetings/i)).toBeInTheDocument();
    expect(screen.getByText(/2 so far/)).toBeInTheDocument();
  });

  it("renders signals and participants when trends are available", async () => {
    useTeamTrends.mockReturnValue({
      data: {
        available: true,
        trends: {
          meetings: 5,
          balanceSlope: 0.1,
          balanceSeries: [{ balance: 0.5 }, { balance: 0.7 }],
          signals: [
            { kind: "rising_dominance", severity: 0.8, message: "Ana is dominating" },
          ],
          participants: [
            { name: "Ana", firstShare: 0.3, lastShare: 0.6 },
            { name: "João", firstShare: 0.5, lastShare: 0.3 },
          ],
        },
      },
    });
    await renderTrends();

    expect(screen.getByText(/5 meetings/)).toBeInTheDocument();
    expect(screen.getByText("Ana is dominating")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText("João")).toBeInTheDocument();
  });

  it("hides the signals section when there are none", async () => {
    useTeamTrends.mockReturnValue({
      data: {
        available: true,
        trends: {
          meetings: 3,
          balanceSlope: 0,
          balanceSeries: [{ balance: 0.5 }],
          signals: [],
          participants: [{ name: "Ana", firstShare: 0.5, lastShare: 0.5 }],
        },
      },
    });
    await renderTrends();
    expect(screen.getByText(/3 meetings/)).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
  });
});
