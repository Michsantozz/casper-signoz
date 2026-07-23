// Drive the assistant agent once through the real Mastra observability wiring
// (createObservability → OtelExporter proto+logs → SigNoz). Stateless turn (no
// memory/threadId) to avoid DB thread setup. Flush spans before exit.
import { mastra } from "@/mastra";
import { flushLlmTelemetry } from "@/mastra/llm-telemetry";

async function main() {
  const agent = mastra.getAgent("assistantAgent");
  const prompt =
    "SMOKETEST-" + process.pid + ": in one sentence, why does tracing matter?";

  // Try generate (non-stream) first; fall back to stream+drain.
  let out = "";
  try {
    const res: any = await (agent as any).generate(prompt);
    out = res?.text ?? "";
    console.log("AGENT_OUTPUT:", String(out).slice(0, 240));
    console.log("USAGE:", JSON.stringify(res?.usage ?? res?.totalUsage ?? {}));
  } catch (e) {
    console.error("GENERATE_ERROR:", (e as Error)?.message);
  } finally {
    // ALWAYS drain — even on error the root/model spans need to export.
    await new Promise((r) => setTimeout(r, 9000));
    // Our own OTLP provider (llm-telemetry) needs its own flush — Mastra's
    // shutdown does not touch it.
    await flushLlmTelemetry();
    try {
      await (mastra.observability as any)?.shutdown?.();
    } catch (e) {
      console.error("shutdown err", (e as Error)?.message);
    }
    console.log("DONE_FLUSHED");
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FATAL", e);
    process.exit(1);
  },
);
