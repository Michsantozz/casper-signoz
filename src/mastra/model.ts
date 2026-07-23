import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";

import { requireEnv } from "@/shared/lib/env";

// Bedrock DNS often returns a mix of public and CGNAT (100.64/10) addresses on
// WSL2/VPN setups; undici's Happy-Eyeballs can latch onto a blackholed IP and
// stall for the full 10s connect timeout (UND_ERR_CONNECT_TIMEOUT). Retrying
// re-runs DNS resolution, so a fresh attempt usually lands on a reachable IP.
const CONNECT_RETRIES = 3;

export function isRetryableNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code =
    (error as { code?: string }).code ??
    ((error as { cause?: { code?: string } }).cause?.code ?? "");
  return (
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    // undici surfaces connect failures as a bare TypeError ("fetch failed")
    error.name === "TypeError"
  );
}

export const resilientFetch: typeof fetch = async (input, init) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CONNECT_RETRIES; attempt++) {
    if (init?.signal?.aborted) {
      throw init.signal.reason ?? new Error("Request aborted.");
    }
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      const aborted = init?.signal?.aborted === true;
      if (
        aborted ||
        attempt === CONNECT_RETRIES ||
        !isRetryableNetworkError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
};

export function createBedrockModel() {
  const bedrock = createAmazonBedrock({
    region: requireEnv("BEDROCK_REGION"),
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    ...(process.env.AWS_SESSION_TOKEN
      ? { sessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
    fetch: resilientFetch,
  });

  return bedrock(requireEnv("BEDROCK_MODEL_ID"));
}

// Fireworks AI (AMD Hackathon Track 3 — inference runs on AMD hardware).
// `fireworks-ai` is a Mastra-registered provider, so we pass the MAGIC STRING
// (`fireworks-ai/<model>`) and let Mastra resolve the endpoint + read the key
// from FIREWORKS_API_KEY (the provider's apiKeyEnvVar). Passing an explicit
// {url,apiKey} object instead made Mastra treat it as a custom provider and the
// request silently produced an empty response (no auth applied). requireEnv
// still asserts the key is present at request time (fail fast, not fail silent).
const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/models/glm-5p2";

export function createFireworksModel() {
  const id = process.env.FIREWORKS_MODEL_ID ?? DEFAULT_FIREWORKS_MODEL;
  return {
    url: "https://api.fireworks.ai/inference/v1/",
    id: `fireworks-ai/${id}` as `${string}/${string}`,
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  };
}

// Provider dispatcher — MODEL_PROVIDER selects the backend at request time.
// Defaults to Fireworks (the hackathon target); Bedrock stays as a fallback so
// existing flows keep working if FIREWORKS_API_KEY is absent.
export function createModel() {
  const provider = (process.env.MODEL_PROVIDER ?? "fireworks").toLowerCase();
  if (provider === "bedrock") return createBedrockModel();
  return createFireworksModel();
}

// ai-sdk LanguageModel for structured generation (generateObject/generateText).
// Unlike createFireworksModel() — which returns Mastra's router CONFIG object —
// this returns a real ai-sdk model via the OpenAI provider pointed at Fireworks'
// OpenAI-compatible endpoint, so it plugs straight into `generateObject`. Used
// by server-side one-shot LLM calls (e.g. the meeting-health insight) that don't
// go through the Mastra agent runtime. Honors MODEL_PROVIDER=bedrock as fallback.
export function createChatModel() {
  const provider = (process.env.MODEL_PROVIDER ?? "fireworks").toLowerCase();
  if (provider === "bedrock") return createBedrockModel();
  const fireworks = createOpenAI({
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  });
  return fireworks.chat(
    process.env.FIREWORKS_MODEL_ID ?? DEFAULT_FIREWORKS_MODEL,
  );
}

// Embedder for Memory semantic recall — runs on Fireworks' OpenAI-compatible
// /embeddings endpoint via the @ai-sdk/openai provider (baseURL override), so we
// reuse the same FIREWORKS_API_KEY. $0.10/M tokens — one embed per stored message
// and one per recall query. Lazy for the same reason as the chat model.
const DEFAULT_EMBEDDING_MODEL = "accounts/fireworks/models/qwen3-embedding-8b";

// Qwen3-Embedding-8B natively outputs 4096-dim vectors, but pgvector CANNOT index
// beyond 2000 dims (the cap applies to every index type — ivfflat AND hnsw — for
// the `vector` type). Mastra's Memory always creates its index without a config,
// so PgVector tries the default index at the embedder's native dimension and
// fails ("column cannot have more than 2000 dimensions"). That failure aborts the
// per-turn memory save, the step never completes, Mastra re-runs it, and the
// whole answer regenerates in an infinite loop (the chat-loop bug).
//
// Fix: Qwen3-Embedding supports Matryoshka (MRL) truncation via the `dimensions`
// request param (verified against the live Fireworks endpoint) — the first N
// components carry the most information, so a truncated vector keeps most of the
// model's quality. We truncate to 1024 dims, which is comfortably indexable, and
// the resulting index name becomes `memory_messages_1024`. Keep this in sync with
// MEMORY_EMBEDDING_DIMENSION in src/mastra/storage.ts.
const EMBEDDING_DIMENSIONS = 1024;

export function createEmbedder() {
  const fireworks = createOpenAI({
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKey: requireEnv("FIREWORKS_API_KEY"),
  });
  const base = fireworks.embedding(
    process.env.FIREWORKS_EMBEDDING_MODEL_ID ?? DEFAULT_EMBEDDING_MODEL,
  );

  // Inject `dimensions` into every embed call. The @ai-sdk/openai model reads it
  // from providerOptions.openai.dimensions in doEmbed and forwards it to the
  // /embeddings request body. Mastra's Memory calls doEmbed itself (we don't own
  // the call site), so we wrap the model to merge the option in — preserving any
  // providerOptions Memory passes. Everything else delegates to the base model.
  return {
    ...base,
    async doEmbed(options: Parameters<typeof base.doEmbed>[0]) {
      const result = await base.doEmbed({
        ...options,
        providerOptions: {
          ...options.providerOptions,
          openai: {
            ...options.providerOptions?.openai,
            dimensions: EMBEDDING_DIMENSIONS,
          },
        },
      });
      // Fail-fast guard: Mastra names/creates the pgvector index from the ACTUAL
      // returned vector length (embeddings[0].length), NOT our requested
      // `dimensions`. If Fireworks ever ignores the param (model swap via
      // FIREWORKS_EMBEDDING_MODEL_ID, API change, fallback), a wrong-sized vector
      // would silently build a different index — and if it exceeds 2000 dims,
      // reopen the exact chat-loop bug this truncation was added to fix. Assert
      // the contract loudly instead of drifting silently.
      const got = result.embeddings[0]?.length;
      if (got !== undefined && got !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Embedder returned ${got}-dim vectors; expected ${EMBEDDING_DIMENSIONS}. ` +
            `The Fireworks 'dimensions' truncation was not honored — refusing to ` +
            `build a mismatched pgvector index (see src/mastra/storage.ts).`,
        );
      }
      return result;
    },
  };
}
