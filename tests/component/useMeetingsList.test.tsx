import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeQueryWrapper } from "../helpers/query-wrapper";

/**
 * useMeetingsList — paginated library query. Fetches GET /api/meetings and
 * exposes `flat` (all loaded pages concatenated) for the list to render. fetch
 * is mocked; we validate the read contract, the querystring built from filters,
 * and cursor-following pagination.
 */

import { useMeetingsList } from "@/features/meetings/model/queries";

const originalFetch = globalThis.fetch;

/** Mock fetch that returns different bodies per matched URL substring. */
function mockFetchByUrl(routes: Array<{ match: string; body: unknown }>) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    const hit = routes.find((r) => url.includes(r.match)) ?? routes[0];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => hit.body,
    });
  }) as unknown as typeof fetch;
}

function mockFetch(body: unknown, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("useMeetingsList", () => {
  it("calls /api/meetings and flattens the page into `flat`", async () => {
    const meetings = [
      { botId: "a", status: "done", participantCount: 2 },
      { botId: "b", status: "processing", participantCount: 0 },
    ];
    mockFetch({ meetings, nextCursor: null });

    const { wrapper } = makeQueryWrapper();
    const { result } = renderHook(() => useMeetingsList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.flat).toEqual(meetings);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/meetings",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("empty page → flat is []", async () => {
    mockFetch({ meetings: [], nextCursor: null });
    const { wrapper } = makeQueryWrapper();
    const { result } = renderHook(() => useMeetingsList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.flat).toEqual([]);
  });

  it("builds the querystring from q + status filters", async () => {
    mockFetch({ meetings: [], nextCursor: null });
    const { wrapper } = makeQueryWrapper();
    renderHook(() => useMeetingsList({ q: "pricing", status: "done" }), {
      wrapper,
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("q=pricing");
    expect(url).toContain("status=done");
  });

  it("follows nextCursor on fetchNextPage and appends the next page", async () => {
    mockFetchByUrl([
      // First page (no cursor): one item + a cursor.
      { match: "cursor=", body: { meetings: [{ botId: "b" }], nextCursor: null } },
      { match: "/api/meetings", body: { meetings: [{ botId: "a" }], nextCursor: "cur-1" } },
    ]);

    const { wrapper } = makeQueryWrapper();
    const { result } = renderHook(() => useMeetingsList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.flat).toEqual([{ botId: "a" }]);
    expect(result.current.hasNextPage).toBe(true);

    result.current.fetchNextPage();

    await waitFor(() => expect(result.current.flat).toHaveLength(2));
    expect(result.current.flat).toEqual([{ botId: "a" }, { botId: "b" }]);
  });

  it("non-ok response becomes a query error", async () => {
    mockFetch({ error: "boom" }, false);
    const { wrapper } = makeQueryWrapper();
    const { result } = renderHook(() => useMeetingsList(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
