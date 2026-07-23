import { PostgresStore, PgVector } from "@mastra/pg";
import { sql } from "drizzle-orm";
import { db } from "@/shared/db";

/**
 * Shared Postgres storage for Mastra — the SAME database as the app (DATABASE_URL,
 * PG :5434). Mastra creates/manages its own tables (mastra_*) in this database,
 * separate from the app's tables (user/session/signature_requests/…).
 *
 * Used in two places:
 *  - new Mastra({ storage }) → persists traces, telemetry and workflow state
 *    (essential so the autonomous loop/cron doesn't lose context between runs).
 *  - new Memory({ storage })  → persists agent threads/messages, so the
 *    agent REMEMBERS previous conversations.
 *
 * Singleton: avoids opening multiple pools on hot-reload (dev) / serverless.
 */
const globalForStore = globalThis as unknown as {
  __mastraStore?: PostgresStore;
  __mastraVector?: PgVector;
  __mastraStoreInit?: Promise<void>;
  __mastraVectorIndexInit?: Promise<void>;
};

// Embedder is Fireworks Qwen3-Embedding-8B, truncated to 1024 dims via MRL (see
// createEmbedder in src/mastra/model.ts — its native 4096 dims exceed pgvector's
// 2000-dim index cap and loop the chat). Memory derives the message-embedding
// index name as `memory_messages_<dim>` (see @mastra/memory), so this MUST match
// the embedder's actual output dimension. Keep in sync with EMBEDDING_DIMENSIONS
// in model.ts — a mismatch pre-creates the wrong index and Memory falls back to
// its default index creation at the real dimension.
const MEMORY_EMBEDDING_DIMENSION = 1024;
const MEMORY_MESSAGES_INDEX = `memory_messages_${MEMORY_EMBEDDING_DIMENSION}`;

export function getMastraStore(): PostgresStore {
  if (!globalForStore.__mastraStore) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL missing — Mastra storage cannot start.");
    }
    globalForStore.__mastraStore = new PostgresStore({
      id: "casper-mastra",
      // Isolates Mastra's tables in their own schema — doesn't pollute `public`
      // where the app's tables live (user/session/signature_requests/…).
      schemaName: "mastra",
      connectionString,
    });
  }
  return globalForStore.__mastraStore;
}

/**
 * Vector store for Memory semantic recall — pgvector in the SAME database
 * (DATABASE_URL), isolated in the `mastra` schema alongside the other Mastra
 * tables. Memory stores message embeddings here and queries them by similarity;
 * the embedder is Fireworks Qwen3-Embedding-8B (see createEmbedder).
 *
 * The embedder produces 4096-dim vectors (index name `memory_messages_4096`).
 * That dimension is why we pre-create the index ourselves in
 * ensureMastraVectorIndex below instead of letting Memory auto-create it: Memory
 * calls PgVector.createIndex WITHOUT an indexConfig, whose default is `ivfflat`,
 * and pgvector's ivfflat is HARD-CAPPED at 2000 dimensions — it fails with
 * "column cannot have more than 2000 dimensions for ivfflat index". That failure
 * aborts the per-turn memory save, the step never completes, and Mastra
 * re-runs it → the whole response regenerates in an infinite loop.
 *
 * Singleton for the same hot-reload/serverless reason as the store.
 */
export function getMastraVector(): PgVector {
  if (!globalForStore.__mastraVector) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL missing — Mastra vector store cannot start.");
    }
    globalForStore.__mastraVector = new PgVector({
      id: "casper-mastra-vector",
      schemaName: "mastra",
      connectionString,
    });
  }
  return globalForStore.__mastraVector;
}

/**
 * Runs `PostgresStore.init()` exactly ONCE per process, memoized as a shared
 * promise. `init()` runs schema DDL through a single PINNED backend connection
 * (RoutingDbClient.pin) and THROWS if a client is already pinned — so two
 * operations that each trigger a lazy first-time init concurrently collide with
 * "RoutingDbClient already has a pinned client". That happens as soon as a page
 * fires parallel memory calls on a cold store (e.g. the meeting notebook's
 * thread `initialize` + history `load` on mount). Awaiting this before the first
 * memory op serializes init so the pin/unpin never overlap. Idempotent: after
 * the first call it resolves instantly; on failure it clears so a retry re-inits.
 */
export function ensureMastraStoreInit(): Promise<void> {
  if (!globalForStore.__mastraStoreInit) {
    globalForStore.__mastraStoreInit = getMastraStore()
      .init()
      .catch((err) => {
        // Don't cache a failed init — let the next caller retry.
        globalForStore.__mastraStoreInit = undefined;
        throw err;
      });
  }
  return globalForStore.__mastraStoreInit;
}

/**
 * Pre-creates the 1024-dim message-embedding index as HNSW, ONCE per process,
 * before Memory ever touches the vector store.
 *
 * Why HNSW here rather than Memory's default: Memory calls PgVector.createIndex
 * WITHOUT an indexConfig, and PgVector's default type is `ivfflat`. ivfflat has a
 * much lower quality/recall profile than HNSW for semantic recall. Since we can
 * safely index at 1024 dims (well under pgvector's 2000 cap), we pre-build HNSW —
 * PgVector.createIndex creates the table (CREATE TABLE IF NOT EXISTS) AND the
 * index, and its setupIndex PRESERVES an already-existing index when later called
 * with an empty config, so Memory's subsequent createIndex becomes a no-op that
 * keeps our HNSW. cosine matches Memory's default metric.
 *
 * (The embedder is truncated to 1024 dims via MRL precisely so this — and Memory's
 * own indexing — stays under the 2000-dim cap; at the native 4096 dims NO index
 * type is creatable and the failed save loops the chat. See createEmbedder.)
 *
 * Idempotent and memoized like the store init; on failure it clears so the next
 * caller retries. Best-effort: callers await it alongside store init.
 */
export function ensureMastraVectorIndex(): Promise<void> {
  if (!globalForStore.__mastraVectorIndexInit) {
    globalForStore.__mastraVectorIndexInit = getMastraVector()
      .createIndex({
        indexName: MEMORY_MESSAGES_INDEX,
        dimension: MEMORY_EMBEDDING_DIMENSION,
        metric: "cosine",
        indexConfig: { type: "hnsw" },
      })
      .catch((err) => {
        globalForStore.__mastraVectorIndexInit = undefined;
        throw err;
      });
  }
  return globalForStore.__mastraVectorIndexInit;
}

/**
 * Ensures the working-memory `mastra_resources` row for a user EXISTS before the
 * agent runs, so Mastra's own resource write is always an UPDATE, never a racing
 * INSERT.
 *
 * Why: with workingMemory scope:'resource' on, Mastra persists the per-user
 * profile via updateResource() — a check-then-act (getResourceById → if missing,
 * saveResource) whose INSERT has NO `ON CONFLICT`. On a user's FIRST turn, two
 * concurrent writers (the supervisor + a delegated sub-agent inheriting its
 * memory, or two browser tabs) both see "no row" and both INSERT; the second
 * violates the `mastra_resources_pkey` PK. That error is uncaught in Mastra's
 * stack, aborts the turn's memory save, the step never completes, Mastra re-runs
 * it → the whole answer regenerates in a loop (the same failure class as the
 * chat-loop bug, in a sibling table).
 *
 * Fix: pre-create the row with `ON CONFLICT (id) DO NOTHING` — a SINGLE insert
 * whose race is resolved by the PK itself (no read-then-write window). After
 * this, getResourceById always finds the row, so Mastra takes the UPDATE branch,
 * which is safe under concurrency. Idempotent; runs on the shared app pool (same
 * DATABASE_URL as the Mastra store). Per-request (resourceId = user id), so it's
 * not memoized like the process-wide inits above.
 */
export async function ensureMastraResource(resourceId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO mastra.mastra_resources (id, "createdAt", "updatedAt")
    VALUES (${resourceId}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}
