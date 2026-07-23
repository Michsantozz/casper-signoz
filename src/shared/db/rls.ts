import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Row-Level Security (RLS) — multi-tenant isolation at the DATABASE level.
 *
 * Tenant tables (with a user_id column) have FORCE ROW LEVEL SECURITY + policies
 * `USING (app_row_visible(user_id))` — see migration 0008. The predicate passes
 * when the row belongs to the scope's user (app.user_id) or under system bypass
 * (app.bypass_rls). Outside a scope, no flag is set → the policies return no
 * rows at all: fail-closed by construction.
 *
 * Usage pattern: repositories call scopedDb() to get the current connection
 * (the transaction with the flag set, if inside a scope; otherwise the base db).
 * The entry points open the scope:
 *   - withUserScope(userId, fn)  → reads/writes on behalf of a user (UI/tools);
 *   - withSystemScope(fn)        → webhooks and crons (act on behalf of multiple users).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Current scoped connection (transaction with the RLS flag set). Propagated
// through the call stack via AsyncLocalStorage — repos don't need to receive
// the tx as a parameter.
const scopeStore = new AsyncLocalStorage<Tx>();

/**
 * Connection to use in tenant queries: the current scoped transaction, or the
 * base db (outside a scope — in that case the policies filter everything, fail-closed).
 *
 * Typed as `typeof db`: the transaction (Tx) exposes the same query builder
 * API, so the cast preserves type inference in the repositories.
 */
export function scopedDb(): typeof db {
  return (scopeStore.getStore() ?? db) as typeof db;
}

/** Opens a user scope: SET LOCAL app.user_id and runs fn under it. */
export async function withUserScope<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!userId) {
    throw new Error("withUserScope: userId is required (RLS fail-closed)");
  }
  return db.transaction(async (tx) => {
    // set_config(_, _, true) = LOCAL (transaction scope; doesn't leak into the pool).
    // Parameterized — userId is never interpolated into the SQL string.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return scopeStore.run(tx, fn);
  });
}

/**
 * Opens a SYSTEM scope (bypasses the per-user filter) — webhooks and crons
 * that act on behalf of multiple users (settle, reconcile, Recall webhook).
 * Use only in server code with no direct user input.
 */
export async function withSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return scopeStore.run(tx, fn);
  });
}

/**
 * Boot guard for RLS hardening. FORCE ROW LEVEL SECURITY makes the policies
 * apply even to the table owner, so isolation holds regardless of the connecting
 * role — but connecting as the OWNER (or a BYPASSRLS/SUPERUSER role) is a
 * defense-in-depth weakness: a future migration that drops FORCE, or DDL run on
 * this connection, would silently remove the protection. The correct deploy
 * connects as the non-owner `app_user` (see drizzle/0008 + docs/rls.md).
 *
 * This checks the current role once at startup and logs a warning if it can
 * bypass RLS or owns the tenant tables. Best-effort: never throws (a failed
 * check must not take the app down). Call once on server boot.
 */
let rlsGuardChecked = false;
export async function assertRlsHardening(): Promise<void> {
  if (rlsGuardChecked) return;
  rlsGuardChecked = true;
  try {
    const rows = (await db.execute(sql`
      select
        current_user as role,
        (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as can_bypass,
        pg_catalog.pg_get_userbyid(c.relowner) = current_user as owns_meeting_records
      from pg_class c
      where c.relname = 'meeting_records'
      limit 1
    `)) as unknown as Array<{
      role: string;
      can_bypass: boolean | null;
      owns_meeting_records: boolean | null;
    }>;
    const r = rows[0];
    if (!r) return;

    // A role que pode BYPASS (superuser/BYPASSRLS) ignora até FORCE ROW LEVEL
    // SECURITY → isolamento multi-tenant NÃO existe. Em produção isto é uma
    // falha crítica, não um aviso: falha o boot (fail-closed) para nunca servir
    // tráfego com tenants misturados. Ver drizzle/0020_rls_app_user_grants.sql.
    if (r.can_bypass) {
      const msg =
        `[rls] app is connected as "${r.role}", which can BYPASS RLS ` +
        `(superuser/BYPASSRLS). Tenant isolation is DISABLED — connect as the ` +
        `non-owner "app_user" role (DATABASE_URL=postgres://app_user:...). ` +
        `See drizzle/0008_rls_multitenant.sql + 0020_rls_app_user_grants.sql.`;
      if (process.env.NODE_ENV === "production") throw new Error(msg);
      console.warn(msg);
      return;
    }

    // Owner sem bypass: FORCE ainda isola as linhas, mas é uma fraqueza de
    // defesa-em-profundidade (uma migração que remova FORCE reabriria o furo).
    // Avisa em qualquer ambiente; não bloqueia.
    if (r.owns_meeting_records) {
      console.warn(
        `[rls] app is connected as "${r.role}", which OWNS the tenant tables. ` +
          `FORCE ROW LEVEL SECURITY still isolates rows, but for ` +
          `defense-in-depth connect as the non-owner "app_user" role ` +
          `(see drizzle/0020_rls_app_user_grants.sql).`,
      );
    }
  } catch (err) {
    // Um throw de produção (bypass detectado) deve propagar e derrubar o boot.
    // Só engolimos falhas DIAGNÓSTICAS (query/DB indisponível no check).
    if (err instanceof Error && err.message.startsWith("[rls]")) throw err;
    // Diagnostic only — never block boot on a failed check.
  }
}
