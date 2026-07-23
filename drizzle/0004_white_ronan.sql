CREATE TYPE "public"."signature_request_kind" AS ENUM('payment', 'setup');--> statement-breakpoint
CREATE TYPE "public"."signature_request_status" AS ENUM('pending', 'ready', 'broadcast', 'confirmed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "wallet_link_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "signature_requests_status_idx";--> statement-breakpoint
DROP INDEX "notifications_user_unread_idx";--> statement-breakpoint
ALTER TABLE "signature_requests" ALTER COLUMN "kind" SET DATA TYPE "public"."signature_request_kind" USING "kind"::"public"."signature_request_kind";--> statement-breakpoint
ALTER TABLE "signature_requests" ALTER COLUMN "status" SET DEFAULT 'pending'::"public"."signature_request_status";--> statement-breakpoint
ALTER TABLE "signature_requests" ALTER COLUMN "status" SET DATA TYPE "public"."signature_request_status" USING "status"::"public"."signature_request_status";--> statement-breakpoint
ALTER TABLE "signature_requests" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_link_nonces" ADD CONSTRAINT "wallet_link_nonces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_link_nonces_user_idx" ON "wallet_link_nonces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "signature_requests_active_idx" ON "signature_requests" USING btree ("created_at" DESC NULLS LAST) WHERE "signature_requests"."status" in ('pending','ready');--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_threshold_check" CHECK ("signature_requests"."threshold" >= 1);