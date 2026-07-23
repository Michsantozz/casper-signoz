-- Persistence audit fixes (Supabase Postgres best-practices sweep).
--
-- Four independent hardening steps, each idempotent so a partial re-run is safe:
--   1. meeting_records: composite (created_at desc, bot_id desc) index backing
--      the keyset-paginated library query + its stable tiebreaker.
--   2. jsonb expression indexes for the metadata->>'…' filters that were seq-scanning.
--   3. auth tables (user/session/account/verification): timestamp → timestamptz.
--   4. oauth_state_nonce: index expires_at for the periodic sweep.
--
-- NOT INCLUDED — RLS policy rewrite: the audit flagged app_row_visible("user_id")
-- as a per-row function call and proposed wrapping the GUC lookups in (select …)
-- for InitPlan caching (Supabase's RLS-performance rule). EXPLAIN ANALYZE on
-- Postgres 17 with 200k rows showed NO measurable win — the planner already
-- folds the STABLE current_setting() predicate, and the rewritten policy was if
-- anything marginally slower. That rule targets expensive predicates (auth.uid()
-- JWT parsing, EXISTS-subqueries), not a bare current_setting(). Rewriting a
-- security policy for zero measured gain is pure risk, so app_row_visible stays.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. meeting_records keyset index — (created_at DESC, bot_id DESC).
--
-- listMeetingRecordsPage orders by created_at DESC and now carries bot_id as the
-- keyset tiebreaker (two rows can share created_at when webhooks land in the same
-- tick). This composite index serves BOTH the ORDER BY and the (created_at,
-- bot_id) < (cursor) range scan in one index, index-only for the cursor columns.
CREATE INDEX IF NOT EXISTS "meeting_records_created_at_bot_id_idx"
  ON "meeting_records" USING btree ("created_at" DESC, "bot_id" DESC);--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. jsonb expression indexes for the metadata filters that were seq-scanning.
--
-- recall_bots: listUpcomingBotsForUser filters metadata->>'user_id'. Partial on
-- join_at not-null keeps it to the rows the "upcoming" query actually scans.
CREATE INDEX IF NOT EXISTS "recall_bots_metadata_user_id_idx"
  ON "recall_bots" USING btree ((metadata->>'user_id'))
  WHERE join_at IS NOT NULL;--> statement-breakpoint

-- user_calendars: listAutoRecordCalendars (system cron) filters
-- metadata->>'auto_record' = 'true'. Partial index = only the opted-in rows.
CREATE INDEX IF NOT EXISTS "user_calendars_auto_record_idx"
  ON "user_calendars" USING btree ((metadata->>'auto_record'))
  WHERE (metadata->>'auto_record') = 'true';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. auth tables: timestamp → timestamptz.
--
-- better-auth's CLI generated these WITHOUT timezone; the app writes JS Date
-- (UTC) so today's UTC-server deploy is consistent, but a non-UTC session TZ
-- would misread session.expires_at. USING (col AT TIME ZONE 'UTC') reinterprets
-- the stored naive wall-clock as the UTC it was actually written as. Idempotent:
-- ALTER … TYPE timestamptz is a no-op if the column is already timestamptz.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.data_type = 'timestamp without time zone'
      AND (
        (c.table_name = 'user'         AND c.column_name IN ('created_at', 'updated_at')) OR
        (c.table_name = 'session'      AND c.column_name IN ('expires_at', 'created_at', 'updated_at')) OR
        (c.table_name = 'account'      AND c.column_name IN ('access_token_expires_at', 'refresh_token_expires_at', 'created_at', 'updated_at')) OR
        (c.table_name = 'verification' AND c.column_name IN ('expires_at', 'created_at', 'updated_at'))
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''',
      r.table_name, r.column_name, r.column_name
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. oauth_state_nonce sweep support — index the deadline the sweeper filters on.
CREATE INDEX IF NOT EXISTS "oauth_state_nonce_expires_at_idx"
  ON "oauth_state_nonce" USING btree ("expires_at");
