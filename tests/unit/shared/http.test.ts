import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

/**
 * http.ts — the CSRF + body-parsing edge helpers applied by every mutating
 * route. Security-relevant: a regression in assertSameOrigin weakens CSRF for
 * the whole API, and parseBody is the single validated-JSON gate.
 *
 * next/headers' headers() is async and server-only; we mock it to drive the
 * Origin/Host pairs. parseBody takes a real Request, so we build those directly.
 */
const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

/** Builds a mock ReadonlyHeaders exposing just .get(). */
function fakeHeaders(map: Record<string, string | null>) {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

async function importHttp() {
  return import("@/shared/lib/http");
}

beforeEach(() => {
  headersMock.mockReset();
});

describe("assertSameOrigin — CSRF guard", () => {
  it("passes (null) when there is no Origin header", async () => {
    headersMock.mockResolvedValue(fakeHeaders({ host: "app.com", origin: null }));
    const { assertSameOrigin } = await importHttp();
    expect(await assertSameOrigin()).toBeNull();
  });

  it("passes when Origin host matches Host", async () => {
    headersMock.mockResolvedValue(
      fakeHeaders({ host: "app.com", origin: "https://app.com" }),
    );
    const { assertSameOrigin } = await importHttp();
    expect(await assertSameOrigin()).toBeNull();
  });

  it("blocks (403 csrf_origin_mismatch) on a cross-site Origin", async () => {
    headersMock.mockResolvedValue(
      fakeHeaders({ host: "app.com", origin: "https://evil.com" }),
    );
    const { assertSameOrigin } = await importHttp();
    const res = await assertSameOrigin();
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "csrf_origin_mismatch" });
  });

  it("blocks (403 csrf_invalid_origin) when Origin is not a valid URL", async () => {
    headersMock.mockResolvedValue(
      fakeHeaders({ host: "app.com", origin: "not-a-url" }),
    );
    const { assertSameOrigin } = await importHttp();
    const res = await assertSameOrigin();
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "csrf_invalid_origin" });
  });

  it("matches host:port pairs exactly (port mismatch is cross-origin)", async () => {
    headersMock.mockResolvedValue(
      fakeHeaders({ host: "app.com:3000", origin: "https://app.com:4000" }),
    );
    const { assertSameOrigin } = await importHttp();
    expect((await assertSameOrigin())?.status).toBe(403);
  });
});

describe("parseBody — validated JSON gate", () => {
  const schema = z.object({ name: z.string(), n: z.number() });
  const req = (body: string) =>
    new Request("https://app.com/api/x", { method: "POST", body });

  it("returns data on a valid body", async () => {
    const { parseBody } = await importHttp();
    const out = await parseBody(req(JSON.stringify({ name: "a", n: 1 })), schema);
    expect(out.data).toEqual({ name: "a", n: 1 });
    expect(out.response).toBeUndefined();
  });

  it("returns 400 invalid_json on malformed JSON", async () => {
    const { parseBody } = await importHttp();
    const out = await parseBody(req("{not json"), schema);
    expect(out.data).toBeUndefined();
    expect(out.response?.status).toBe(400);
    expect(await out.response?.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 400 validation_failed with issues on schema mismatch", async () => {
    const { parseBody } = await importHttp();
    const out = await parseBody(req(JSON.stringify({ name: "a" })), schema);
    expect(out.response?.status).toBe(400);
    const body = await out.response?.json();
    expect(body.error).toBe("validation_failed");
    expect(body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "n" })]),
    );
  });
});
