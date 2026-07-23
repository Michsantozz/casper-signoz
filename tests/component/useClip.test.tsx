import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * useClip — estado de corte no notebook. Contrato:
 *  - idle → clipping (com id + progresso) → idle (baixa o mp4 no sucesso);
 *  - erro do clipVideo vira status "error" com o id do item;
 *  - abort (DOMException AbortError) NÃO é erro: volta a idle.
 *
 * clipVideo/downloadClip (shared/lib/clip) são mockados — isolamos a máquina de
 * estado do hook, sem WebCodecs.
 */

const clipVideo = vi.fn();
const downloadClip = vi.fn();
vi.mock("@/shared/lib/clip", () => ({
  clipVideo: (...a: unknown[]) => clipVideo(...a),
  downloadClip: (...a: unknown[]) => downloadClip(...a),
}));

import { useClip } from "@/features/meetings/model/useClip";

const ARGS = {
  id: "moment-0",
  videoUrl: "http://x/v.mp4",
  start: 5,
  end: 12,
  filename: "clip-intro",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useClip — sucesso", () => {
  it("clipa, baixa o blob e volta a idle", async () => {
    const blob = new Blob(["x"], { type: "video/mp4" });
    clipVideo.mockResolvedValue({ blob, durationSeconds: 7 });

    const { result } = renderHook(() => useClip());
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      await result.current.run(ARGS);
    });

    expect(clipVideo).toHaveBeenCalledWith(
      expect.objectContaining({ start: 5, end: 12, videoUrl: "http://x/v.mp4" }),
    );
    expect(downloadClip).toHaveBeenCalledWith(blob, "clip-intro");
    expect(result.current.state.status).toBe("idle");
  });

  it("propaga o progresso do clipVideo enquanto corta", async () => {
    let emit: ((p: { progress: number }) => void) | undefined;
    clipVideo.mockImplementation(
      (opts: { onProgress?: (p: { progress: number }) => void }) => {
        emit = opts.onProgress;
        return new Promise(() => {}); // never resolves — fica clipping
      },
    );

    const { result } = renderHook(() => useClip());
    act(() => {
      void result.current.run(ARGS);
    });

    await waitFor(() => expect(result.current.state.status).toBe("clipping"));
    act(() => emit?.({ progress: 0.42 }));

    await waitFor(() => {
      expect(result.current.state).toMatchObject({
        status: "clipping",
        id: "moment-0",
        progress: 0.42,
      });
    });
  });
});

describe("useClip — falha e abort", () => {
  it("erro do clipVideo vira status error com o id", async () => {
    clipVideo.mockRejectedValue(new Error("decode failed"));

    const { result } = renderHook(() => useClip());
    await act(async () => {
      await result.current.run(ARGS);
    });

    expect(result.current.state).toMatchObject({
      status: "error",
      id: "moment-0",
      message: "decode failed",
    });
    expect(downloadClip).not.toHaveBeenCalled();
  });

  it("AbortError não é erro: volta a idle sem baixar", async () => {
    clipVideo.mockRejectedValue(new DOMException("Clip canceled", "AbortError"));

    const { result } = renderHook(() => useClip());
    await act(async () => {
      await result.current.run(ARGS);
    });

    expect(result.current.state.status).toBe("idle");
    expect(downloadClip).not.toHaveBeenCalled();
  });

  it("cancel() aborta o corte em andamento e volta a idle", async () => {
    clipVideo.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useClip());
    act(() => {
      void result.current.run(ARGS);
    });
    await waitFor(() => expect(result.current.state.status).toBe("clipping"));

    act(() => result.current.cancel());
    expect(result.current.state.status).toBe("idle");
  });
});
