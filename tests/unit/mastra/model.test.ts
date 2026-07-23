import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * model.ts — the single point where every LLM provider is wired.
 *
 * Two contracts matter and were untested:
 *  - resilientFetch: retries transient network errors (DNS flake / CGNAT
 *    blackhole on WSL2) up to CONNECT_RETRIES, but NOT on abort or a
 *    non-retryable error. A regression here silently breaks Bedrock on flaky
 *    DNS or, worse, retries an aborted request.
 *  - createModel / createChatModel: dispatch on MODEL_PROVIDER (fireworks
 *    default, bedrock fallback). A regression breaks provider selection.
 *
 * @ai-sdk providers are mocked so nothing hits the network; requireEnv reads
 * the process env we set here.
 */
const createAmazonBedrock = vi.fn((_cfg: unknown) => (id: string) => ({
  provider: "bedrock",
  id,
}));
const chat = vi.fn((id: string) => ({ provider: "fireworks", id }));
const createOpenAI = vi.fn((_cfg: unknown) => ({
  chat,
  embedding: (id: string) => ({ id }),
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: (cfg: unknown) => createAmazonBedrock(cfg),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (cfg: unknown) => createOpenAI(cfg),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIREWORKS_API_KEY = "fw-test";
  process.env.BEDROCK_REGION = "us-east-1";
  process.env.BEDROCK_MODEL_ID = "anthropic.claude";
  process.env.AWS_ACCESS_KEY_ID = "ak";
  process.env.AWS_SECRET_ACCESS_KEY = "sk";
  delete process.env.MODEL_PROVIDER;
  delete process.env.FIREWORKS_MODEL_ID;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function importModel() {
  return import("@/mastra/model");
}

describe("isRetryableNetworkError", () => {
  it("true for known transient codes", async () => {
    const { isRetryableNetworkError } = await importModel();
    for (const code of [
      "UND_ERR_CONNECT_TIMEOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
    ]) {
      expect(isRetryableNetworkError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
  });

  it("true for a bare undici TypeError, reads nested cause.code", async () => {
    const { isRetryableNetworkError } = await importModel();
    expect(isRetryableNetworkError(new TypeError("fetch failed"))).toBe(true);
    const nested = Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } });
    expect(isRetryableNetworkError(nested)).toBe(true);
  });

  it("false for non-errors and non-retryable codes", async () => {
    const { isRetryableNetworkError } = await importModel();
    expect(isRetryableNetworkError("nope")).toBe(false);
    expect(isRetryableNetworkError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
  });
});

describe("resilientFetch", () => {
  it("returns immediately on a successful fetch (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { resilientFetch } = await importModel();

    const res = await resilientFetch("https://x");
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("dns"), { code: "EAI_AGAIN" }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { resilientFetch } = await importModel();

    const p = resilientFetch("https://x");
    await vi.runAllTimersAsync();
    const res = await p;
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after CONNECT_RETRIES+1 attempts and throws the last error", async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error("dns"), { code: "EAI_AGAIN" });
    const fetchMock = vi.fn().mockRejectedValue(err);
    vi.stubGlobal("fetch", fetchMock);
    const { resilientFetch } = await importModel();

    const p = resilientFetch("https://x");
    const assertion = expect(p).rejects.toThrow("dns");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it("does NOT retry a non-retryable error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("bad"), { code: "EACCES" }));
    vi.stubGlobal("fetch", fetchMock);
    const { resilientFetch } = await importModel();

    await expect(resilientFetch("https://x")).rejects.toThrow("bad");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry (throws) when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resilientFetch } = await importModel();
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));

    await expect(resilientFetch("https://x", { signal: ctrl.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("provider dispatch", () => {
  it("createModel defaults to Fireworks (magic-string config)", async () => {
    const { createModel } = await importModel();
    const m = createModel() as { id: string };
    expect(m.id).toMatch(/^fireworks-ai\//);
  });

  it("createModel honors MODEL_PROVIDER=bedrock", async () => {
    process.env.MODEL_PROVIDER = "bedrock";
    const { createModel } = await importModel();
    createModel();
    expect(createAmazonBedrock).toHaveBeenCalledOnce();
  });

  it("createChatModel defaults to Fireworks OpenAI-compatible chat", async () => {
    const { createChatModel } = await importModel();
    createChatModel();
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: expect.stringContaining("fireworks.ai") }),
    );
    expect(chat).toHaveBeenCalled();
  });

  it("createChatModel honors MODEL_PROVIDER=bedrock", async () => {
    process.env.MODEL_PROVIDER = "bedrock";
    const { createChatModel } = await importModel();
    createChatModel();
    expect(createAmazonBedrock).toHaveBeenCalledOnce();
    expect(createOpenAI).not.toHaveBeenCalled();
  });
});
