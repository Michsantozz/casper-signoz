CREATE TYPE "public"."meeting_record_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_records" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"meeting_url" text,
	"status" "meeting_record_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"transcript" text,
	"summary" text,
	"overview" text,
	"decisions" jsonb,
	"action_items" jsonb,
	"topics" jsonb,
	"sections" jsonb,
	"moments" jsonb,
	"talk_shares" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "meeting_records_user_idx" ON "meeting_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meeting_records_status_idx" ON "meeting_records" USING btree ("status");