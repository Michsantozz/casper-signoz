import { MCPClient } from "@mastra/mcp";
import { DEFAULT_REGION } from "@/server/recall/client";

/**
 * MCP client connecting the agent to Recall.ai.
 *
 * - recall: read-only Recall.ai (bots, recordings, calendar, docs).
 *   Requires RECALL_API_KEY. Writes (create/schedule/control bot) do NOT come
 *   from the MCP — that's in src/mastra/tools/recall.tool.ts (REST). Here it's
 *   read-only.
 *
 * Consumed in the agent via `tools: async () => mcp.listTools()` (DynamicArgument),
 * the canonical pattern: resolved per request, no top-level await at boot.
 */
const recallApiKey = process.env.RECALL_API_KEY;
const recallRegion = process.env.RECALL_REGION || DEFAULT_REGION;

export const mcp = new MCPClient({
  id: "recall-mcp",
  timeout: 30000,
  servers: {
    // Recall.ai (read-only) — only registered when the API key is configured.
    ...(recallApiKey
      ? {
          recall: {
            url: new URL(`https://${recallRegion}.recall.ai/mcp`),
            requestInit: {
              headers: { Authorization: `Bearer ${recallApiKey}` },
            },
          },
        }
      : {}),
  },
});
