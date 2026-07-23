CREATE TABLE "recall_bots" (
	"dedup_key" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"meeting_url" text NOT NULL,
	"join_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_calendars" (
	"recall_calendar_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"platform_email" text,
	"status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recall_bots_bot_id_idx" ON "recall_bots" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "user_calendars_user_id_idx" ON "user_calendars" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_calendars_email_platform_idx" ON "user_calendars" USING btree ("platform_email","platform");