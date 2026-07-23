ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "meeting_records" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "meeting_records" ADD COLUMN "share_created_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "meeting_records_share_token_idx" ON "meeting_records" USING btree ("share_token");--> statement-breakpoint
ALTER TABLE "meeting_records" ADD CONSTRAINT "meeting_records_share_token_unique" UNIQUE("share_token");