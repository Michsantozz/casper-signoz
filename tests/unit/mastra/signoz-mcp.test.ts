import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * SigNoz MCP client (mastra/mcp-signoz.ts) + the sreAgent that consumes it.
 *
 * The core contract is graceful degradation: when SIGNOZ_MCP_URL is unset, the
 * client registers ZERO servers, so listTools() yields an empty toolset and the
 * sreAgent boots fine but has no telemetry tools (it then tells the user the
 * backend isn't wired). When the URL IS set, exactly one "signoz" server is
 * registered with the auth headers. signozMcpEnabled mirrors that env.
 *
 * We mock @mastra/mcp's MCPClient to capture the `servers` config passed to its
 * ctor — no real HTTP transport is opened. Because the env is read at MODULE
 * LOAD, each case sets env then dynamic-imports under resetModules.
 */

const ORIGINAL_ENV = { ...process.env };
const mcpClientCtor = vi.fn();

vi.mock("@mastra/mcp", () => ({
  MCPClient: class {
    constructor(config: unknown) {
      mcpClientCtor(config);
    }
    async listTools() {
      return {};
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  mcpClientCtor.mockReset();
  delete process.env.SIGNOZ_MCP_URL;
  delete process.env.SIGNOZ_MCP_API_KEY;
  delete process.env.SIGNOZ_INSTANCE_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function serversPassed(): Record<string, unknown> {
  const cfg = mcpClientCtor.mock.calls[0][0] as { servers: Record<string, unknown> };
  return cfg.servers;
}

describe("signozMcp — server registration", () => {
  it("registers NO server when SIGNOZ_MCP_URL is unset (graceful no-op)", async () => {
    const { signozMcpEnabled } = await import("@/mastra/mcp-signoz");
    expect(serversPassed()).toEqual({});
    expect(signozMcpEnabled).toBe(false);
  });

  it("registers the signoz server with auth headers when configured", async () => {
    process.env.SIGNOZ_MCP_URL = "https://signoz.example/mcp";
    process.env.SIGNOZ_MCP_API_KEY = "svc-key";
    process.env.SIGNOZ_INSTANCE_URL = "https://signoz.example";

    const { signozMcpEnabled } = await import("@/mastra/mcp-signoz");

    const servers = serversPassed() as {
      signoz?: { url: URL; requestInit: { headers: Record<string, string> } };
    };
    expect(servers.signoz).toBeDefined();
    expect(servers.signoz!.url.toString()).toBe("https://signoz.example/mcp");
    expect(servers.signoz!.requestInit.headers).toEqual({
      "SIGNOZ-API-KEY": "svc-key",
      "X-SigNoz-URL": "https://signoz.example",
    });
    expect(signozMcpEnabled).toBe(true);
  });

  it("omits optional headers when only the URL is set", async () => {
    process.env.SIGNOZ_MCP_URL = "https://signoz.example/mcp";

    await import("@/mastra/mcp-signoz");

    const servers = serversPassed() as {
      signoz: { requestInit: { headers: Record<string, string> } };
    };
    expect(servers.signoz.requestInit.headers).toEqual({});
  });
});

describe("sreAgent — config", () => {
  // The agent module imports createModel (mastra/model.ts) at load; stub it so
  // no real provider/env is needed just to introspect the agent object.
  it("registers with an id/description and a dynamic (async) tools resolver", async () => {
    vi.doMock("@/mastra/model", () => ({ createModel: () => ({}) }));
    const { sreAgent } = await import("@/mastra/agents/sre.agent");

    expect(sreAgent.id).toBe("sreAgent");
    // Description exists and steers the router to telemetry (not meeting content).
    expect(String(sreAgent.getDescription())).toMatch(/telemetry|SigNoz/i);
  });

  it("degrades to an empty toolset when SigNoz MCP is unwired", async () => {
    vi.doMock("@/mastra/model", () => ({ createModel: () => ({}) }));
    // SIGNOZ_MCP_URL unset → the mocked listTools() returns {} → the DynamicArgument
    // resolves to no tools. The agent boots either way (no top-level await).
    const { sreAgent } = await import("@/mastra/agents/sre.agent");
    const tools = await sreAgent.listTools();
    expect(tools).toEqual({});
  });
});
