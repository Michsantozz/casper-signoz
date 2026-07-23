import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "@/shared/lib/env";
import * as schema from "./schema";

/**
 * Shared Drizzle client (node-postgres).
 *
 * Single pool reused across invocations (avoids exhausting connections in
 * serverless and dev hot-reload). Connection via DATABASE_URL.
 */

declare global {
  var __recallPgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__recallPgPool) {
    globalThis.__recallPgPool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
    });
  }
  return globalThis.__recallPgPool;
}

// Drizzle instance created only on first use. If `db` were initialized at the
// top level (`drizzle(getPool())`), `requireEnv("DATABASE_URL")` would run
// already at import time — and `next build` collects page data by importing
// the routes, breaking the build without DATABASE_URL. The Proxy defers the
// connection to runtime, when the env exists.
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
export { schema };
