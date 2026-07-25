/**
 * Verifies the failover's SigNoz health query against a LIVE instance.
 *
 * This is the check that was missing. The query built by model-health.ts feeds
 * the cross-replica failover signal, but nothing in the repo ever executed it
 * against a real SigNoz — only unit tests whose fixtures were derived from the
 * parser itself, so request and response agreed by construction and the actual
 * API contract was never touched. A rejected query shape and an idle window both
 * surface as a silent `null`, so the signal could be permanently absent with no
 * symptom.
 *
 * Run it against the instance the app reports to:
 *
 *   SIGNOZ_INSTANCE_URL=http://localhost:8090 \
 *   SIGNOZ_MCP_API_KEY=<service-account-key> \
 *   DEPLOYMENT_ENVIRONMENT=development \
 *   pnpm verify:signoz
 *
 * Exits non-zero when the query is rejected or the response can't be parsed, so
 * it can gate a demo. "No traffic in window" is reported as INCONCLUSIVE (exit
 * 0 with a warning): the contract held, there was simply nothing to count —
 * drive the agent first, then re-run.
 */
import {
  buildSignozHealthQuery,
  lastSignozProbe,
  refreshSignozHealth,
  signozQueryUrl,
  type Provider,
} from "@/mastra/model-health";

const PROVIDERS: Provider[] = ["fireworks", "bedrock"];

function fail(message: string): never {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

async function main() {
  if (!process.env.SIGNOZ_INSTANCE_URL || !process.env.SIGNOZ_MCP_API_KEY) {
    fail(
      "SIGNOZ_INSTANCE_URL and SIGNOZ_MCP_API_KEY must both be set (a SigNoz service-account key).",
    );
  }

  const environment =
    process.env.DEPLOYMENT_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development";

  console.log(`→ POST ${signozQueryUrl()}`);
  console.log(`→ environment filter: ${environment}\n`);

  // Print the exact body so a rejection can be diffed against the API docs.
  console.log("Request body (provider=fireworks):");
  console.log(
    JSON.stringify(buildSignozHealthQuery("fireworks", Date.now()), null, 2),
  );
  console.log();

  let sawTraffic = false;
  let hardFailure = false;

  for (const provider of PROVIDERS) {
    const health = await refreshSignozHealth(provider);
    const probe = lastSignozProbe(provider);

    if (!probe) {
      console.error(`${provider}: no probe recorded (unexpected)`);
      hardFailure = true;
      continue;
    }

    switch (probe.reason) {
      case "ok":
        sawTraffic = true;
        console.log(
          `✅ ${provider}: CONTRACT OK — samples=${health?.samples}, ` +
            `errorRate=${((health?.errorRate ?? 0) * 100).toFixed(1)}%, ` +
            `p95=${((health?.p95Ms ?? 0) / 1000).toFixed(2)}s`,
        );
        break;
      case "no_traffic":
        console.log(
          `⚠️  ${provider}: INCONCLUSIVE — query accepted (HTTP 200) but no spans in the window. ` +
            `Drive the agent, then re-run.`,
        );
        break;
      case "http_error":
        hardFailure = true;
        console.error(
          `❌ ${provider}: QUERY REJECTED — HTTP ${probe.status}. The request shape is wrong.\n   ${probe.detail}`,
        );
        break;
      case "unparseable":
        hardFailure = true;
        console.error(
          `❌ ${provider}: UNREADABLE RESPONSE — HTTP 200 but no "A" column found. ` +
            `The response envelope isn't one pickSignozQueryValue handles.\n   ${probe.detail}`,
        );
        break;
      case "network_error":
        hardFailure = true;
        console.error(`❌ ${provider}: NETWORK — ${probe.detail}`);
        break;
      case "unconfigured":
        fail("SigNoz env vanished mid-run.");
    }
  }

  if (hardFailure) {
    fail(
      "The health query does NOT work against this instance. The failover's SigNoz signal would be permanently absent (the local circuit breaker would silently carry every decision).",
    );
  }

  if (!sawTraffic) {
    console.log(
      "\n⚠️  Contract verified as far as the API is concerned (queries accepted), but no window had traffic — " +
        "no end-to-end proof yet. Send a chat, then re-run for a full pass.",
    );
  } else {
    console.log(
      "\n✅ End-to-end verified: the failover reads its own error-rate/p95 back out of SigNoz.",
    );
  }
}

// NOT top-level await: package.json has no `"type": "module"`, so tsx/esbuild
// transpiles this file to CJS, where top-level await is a hard parse error
// ("Top-level await is currently not supported with the cjs output format").
// Adding "type": "module" would fix it here and reinterpret every .js in the
// repo — not a trade this script gets to make. `.catch` keeps the non-zero exit
// that `fail()` relies on, and covers rejections `fail()` never sees.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
