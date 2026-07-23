ALTER TABLE "billing_deposits" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signature_approvals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signature_requests" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_ledger" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_wallets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallet_link_nonces" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "billing_deposits" CASCADE;--> statement-breakpoint
DROP TABLE "signature_approvals" CASCADE;--> statement-breakpoint
DROP TABLE "signature_requests" CASCADE;--> statement-breakpoint
DROP TABLE "usage_ledger" CASCADE;--> statement-breakpoint
DROP TABLE "user_wallets" CASCADE;--> statement-breakpoint
DROP TABLE "wallet_link_nonces" CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_request_id_signature_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "request_id";--> statement-breakpoint
DROP TYPE "public"."signature_request_kind";--> statement-breakpoint
DROP TYPE "public"."signature_request_status";