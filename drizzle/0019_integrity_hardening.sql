ALTER TABLE "meeting_records" ADD COLUMN IF NOT EXISTS "summary_notification_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Data hygiene BEFORE the FKs: existing rows may reference a user_id that no
-- longer exists (users deleted before these FKs existed). Adding the constraint
-- would fail on that dangling data. Reconcile it to match each FK's ON DELETE:
--   meeting_records.user_id is nullable + ON DELETE SET NULL → NULL the orphans.
UPDATE "meeting_records" mr
  SET "user_id" = NULL
  WHERE mr."user_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = mr."user_id");--> statement-breakpoint
--   user_calendars.user_id is NOT NULL + ON DELETE CASCADE → a dangling row can't
--   be nulled, so drop it (a calendar owned by a deleted user is unreachable).
DELETE FROM "user_calendars" uc
  WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u."id" = uc."user_id");--> statement-breakpoint
-- FKs added idempotently (guard against a partial re-run): only create if the
-- constraint name isn't already present.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_records_user_id_user_id_fk') THEN
    ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_calendars_user_id_user_id_fk') THEN
    ALTER TABLE "user_calendars" ADD CONSTRAINT "user_calendars_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_calendars_owner_email_platform_uidx" ON "user_calendars" USING btree ("user_id","platform_email","platform");