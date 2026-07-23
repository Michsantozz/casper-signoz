import { mcp } from "../src/mastra/mcp";

async function main() {
  const { toolsets, errors } = await mcp.listToolsetsWithErrors();

  for (const [server, err] of Object.entries(errors)) {
    console.error(`❌ ${server}: ${err}`);
  }

  for (const [server, tools] of Object.entries(toolsets)) {
    const names = Object.keys(tools);
    console.log(`\n✅ ${server} — ${names.length} tools:`);
    for (const name of names) {
      const desc = (tools[name] as { description?: string }).description ?? "";
      console.log(`   • ${name}${desc ? ` — ${desc.slice(0, 80)}` : ""}`);
    }
  }

  await mcp.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
