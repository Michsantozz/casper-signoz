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
let mcpTools: Record<string, unknown> = {};

vi.mock("@mastra/mcp", () => ({
  MCPClient: class {
    constructor(config: unknown) {
      mcpClientCtor(config);
    }
    async listTools() {
      return mcpTools;
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  mcpClientCtor.mockReset();
  mcpTools = {};
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

  it("keeps the human-facing SRE agent strictly read-only", async () => {
    mcpTools = {
      signoz_query_traces: { id: "read" },
      signoz_list_alert_rules: { id: "list" },
      signoz_create_alert: { id: "create-alert" },
      signoz_create_dashboard: { id: "create-dashboard" },
      signoz_delete_alert: { id: "delete" },
      signoz_update_dashboard: { id: "update" },
      signoz_rotate_api_key: { id: "unknown-mutation" },
    };
    vi.doMock("@/mastra/model", () => ({ createModel: () => ({}) }));
    const { sreAgent } = await import("@/mastra/agents/sre.agent");

    expect(Object.keys(await sreAgent.listTools()).sort()).toEqual([
      "signoz_list_alert_rules",
      "signoz_query_traces",
    ]);
  });

  it("gives internal automation only approved create capabilities", async () => {
    mcpTools = {
      signoz_query_traces: { id: "read" },
      signoz_create_alert: { id: "create-alert" },
      signoz_create_dashboard: { id: "create-dashboard" },
      signoz_delete_alert: { id: "delete" },
      signoz_update_alert: { id: "update" },
      signoz_mute_alert: { id: "mute" },
      signoz_rotate_api_key: { id: "unknown-mutation" },
    };
    vi.doMock("@/mastra/model", () => ({ createModel: () => ({}) }));
    const { sreAutomationAgent } = await import("@/mastra/agents/sre.agent");

    expect(Object.keys(await sreAutomationAgent.listTools()).sort()).toEqual([
      "signoz_create_alert",
      "signoz_create_dashboard",
      "signoz_query_traces",
    ]);
  });
});

// ── Autonomous-write idempotency ────────────────────────────────────────────
//
// The health watch runs every 15 min with create-alert authority and CANNOT
// delete or update. Its only duplicate-defense used to be a prompt sentence
// ("list existing rules and DON'T duplicate one") — a semantic judgment made by
// an LLM over names it generated itself. Uniqueness now lives in code.

describe("withAlertIdempotency — deterministic duplicate guard", () => {
  async function loadGuard() {
    return import("@/mastra/mcp-signoz");
  }

  it("derives one canonical key across cosmetic rewordings", async () => {
    const { canonicalAlertKey } = await loadGuard();
    expect(canonicalAlertKey("Tool call failures")).toBe("tool-call-failures");
    expect(canonicalAlertKey("  TOOL CALL   FAILURES!  ")).toBe(
      "tool-call-failures",
    );
    // The reserved prefix is stripped, so a rule this loop created earlier
    // collapses onto the same key as a fresh proposal for the same symptom.
    expect(canonicalAlertKey("casper-auto/tool-call-failures")).toBe(
      "tool-call-failures",
    );
  });

  it("creates when nothing covers the symptom, stamping the reserved prefix", async () => {
    const { withAlertIdempotency } = await loadGuard();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = withAlertIdempotency({ execute }, async () => [
      "Some unrelated rule",
    ]);

    await guarded.execute!({ context: { alert: "Tool call failures" } } as never);

    expect(execute).toHaveBeenCalledTimes(1);
    const passed = execute.mock.calls[0][0] as { context: { alert: string } };
    expect(passed.context.alert).toBe("casper-auto/tool-call-failures");
  });

  it("turns a duplicate into a no-op instead of a second permanent rule", async () => {
    const { withAlertIdempotency } = await loadGuard();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = withAlertIdempotency({ execute }, async () => [
      "casper-auto/tool-call-failures",
    ]);

    // A later tick rewords the same symptom — the canonical key still matches.
    const result = (await guarded.execute!({
      context: { alert: "Tool Call Failures" },
    } as never)) as { created: boolean; deduplicated: boolean };

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: false, deduplicated: true });
  });

  it("fails CLOSED when existing rules cannot be listed", async () => {
    // Can't prove it isn't a duplicate, and the loop cannot delete a mistake.
    // Skipping one cycle is recoverable; an undeletable duplicate is not.
    const { withAlertIdempotency } = await loadGuard();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = withAlertIdempotency({ execute }, async () => {
      throw new Error("MCP list failed");
    });

    const result = (await guarded.execute!({
      context: { alert: "Tool call failures" },
    } as never)) as { created: boolean; reason: string };

    expect(execute).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.reason).toContain("REFUSED");
  });

  it("refuses an unnamed create (it could never be deduplicated later)", async () => {
    const { withAlertIdempotency } = await loadGuard();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = withAlertIdempotency({ execute }, async () => []);

    const result = (await guarded.execute!({
      context: { threshold: 5 },
    } as never)) as { created: boolean };

    expect(execute).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
  });

  it("wraps create_alert in the automation toolset but leaves reads untouched", async () => {
    process.env.SIGNOZ_MCP_URL = "http://signoz-mcp:8000/mcp";
    const createAlert = vi.fn().mockResolvedValue({ ok: true });
    mcpTools = {
      signoz_query_traces: { execute: vi.fn() },
      signoz_list_alert_rules: {
        execute: vi.fn().mockResolvedValue([{ alert: "casper-auto/tool-call-failures" }]),
      },
      signoz_create_alert: { execute: createAlert },
    };
    const { listSignozAutomationTools } = await loadGuard();
    const tools = (await listSignozAutomationTools()) as unknown as Record<
      string,
      { execute: (a: unknown) => Promise<unknown> }
    >;

    // The existing rule is discovered through the list tool → dedup, no create.
    const result = (await tools.signoz_create_alert.execute({
      context: { alert: "Tool call failures" },
    })) as { deduplicated?: boolean };

    expect(result.deduplicated).toBe(true);
    expect(createAlert).not.toHaveBeenCalled();
  });
});
