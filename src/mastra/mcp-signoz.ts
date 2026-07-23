import { MCPClient } from "@mastra/mcp";

/**
 * MCP client connecting the agent to its OWN SigNoz telemetry — the "SRE-copilot"
 * path: the agent reads back the traces/metrics/logs it emits, so it can debug
 * itself (token spend by model, failing tools, LLM errors, latency percentiles).
 *
 * Distinct from src/mastra/mcp.ts (Recall.ai): different external system, kept
 * in its own client per the "one client per external system" granularity.
 *
 * Unlike the Recall MCP (which we do NOT wire through directly because its reads
 * are cross-tenant — see assistant.agent.ts), SigNoz telemetry is workspace-wide
 * and single-tenant by nature: an SRE agent inspecting the app's OWN traces is a
 * legitimate internal use with no per-user boundary to violate. So passing the
 * SigNoz MCP tools straight through is safe here.
 *
 * Server: signoz/signoz-mcp-server (HTTP transport). Auth: `SIGNOZ-API-KEY` +
 * optional `X-SigNoz-URL` headers (a SigNoz service-account key + the instance
 * URL). Only registered when SIGNOZ_MCP_URL is set — absent → no tools, no-op.
 *
 * Consumed in the agent via `tools: async () => signozMcp.listTools()`
 * (DynamicArgument): resolved per request, no top-level await at boot.
 */
const signozMcpUrl = process.env.SIGNOZ_MCP_URL;
const signozApiKey = process.env.SIGNOZ_MCP_API_KEY;
const signozInstanceUrl = process.env.SIGNOZ_INSTANCE_URL;

export const signozMcp = new MCPClient({
  id: "signoz-mcp",
  timeout: 30000,
  servers: {
    ...(signozMcpUrl
      ? {
          signoz: {
            url: new URL(signozMcpUrl),
            requestInit: {
              headers: {
                ...(signozApiKey ? { "SIGNOZ-API-KEY": signozApiKey } : {}),
                ...(signozInstanceUrl
                  ? { "X-SigNoz-URL": signozInstanceUrl }
                  : {}),
              },
            },
          },
        }
      : {}),
  },
});

/** True when the SigNoz MCP server is configured (env present). */
export const signozMcpEnabled = Boolean(signozMcpUrl);
