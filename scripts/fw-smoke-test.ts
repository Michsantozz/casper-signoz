import { Agent } from "@mastra/core/agent";
import { createModel } from "@/mastra/model";

// Exercises the SAME provider dispatcher the real agents use (MODEL_PROVIDER →
// Fireworks by default). Proves the Track 3 wiring end-to-end without booting
// the full Mastra app (PG storage, MCP servers, etc).
async function main() {
  console.log("MODEL_PROVIDER:", process.env.MODEL_PROVIDER ?? "(default) fireworks");
  console.log("Key present:", Boolean(process.env.FIREWORKS_API_KEY));

  const model = createModel();
  console.log("Resolved model:", model);

  const agent = new Agent({
    id: "fw-smoke-test",
    name: "FW Smoke Test",
    instructions: "You are a terse assistant. Answer in one short sentence, no preamble.",
    model: () => createModel(),
  });

  console.log("\n--- generate ---");
  const res = await agent.generate("In one word, what network does CasperAgent run on?");
  console.log("text:", res.text);
  console.log("usage:", res.usage);

  console.log("\nSUCCESS");
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  if (e?.cause) console.error("cause:", e.cause);
  process.exit(1);
});
