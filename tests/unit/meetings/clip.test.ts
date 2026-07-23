import { describe, it, expect } from "vitest";
import { clipVideo } from "@/shared/lib/clip";

/**
 * clipVideo — corte de vídeo client-side (mediabunny). O corte real exige
 * WebCodecs (coberto no e2e/browser); aqui garantimos o GUARD de range, que
 * roda ANTES de carregar a mediabunny (import dinâmico): end deve ser > start,
 * senão rejeita sem tocar na lib pesada.
 */

describe("clipVideo — validação de range", () => {
  it("rejeita quando end <= start", async () => {
    await expect(
      clipVideo({ videoUrl: "http://x/v.mp4", start: 10, end: 5 }),
    ).rejects.toThrow(/end .* must be greater than start/);
  });

  it("rejeita quando end === start", async () => {
    await expect(
      clipVideo({ videoUrl: "http://x/v.mp4", start: 7, end: 7 }),
    ).rejects.toThrow(/must be greater than start/);
  });
});
