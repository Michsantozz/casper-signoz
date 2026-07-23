CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"request_id" text,
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"signer_public_key_hex" text NOT NULL,
	"signature_hex" text NOT NULL,
	"signed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"transaction_json" text NOT NULL,
	"chain_name" text NOT NULL,
	"required_signers" jsonb NOT NULL,
	"threshold" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transaction_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key_hex" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_request_id_signature_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."signature_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_approvals" ADD CONSTRAINT "signature_approvals_request_id_signature_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."signature_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_approvals" ADD CONSTRAINT "signature_approvals_signed_by_user_id_user_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "signature_approvals_request_idx" ON "signature_approvals" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signature_approvals_request_signer_uq" ON "signature_approvals" USING btree ("request_id","signer_public_key_hex");--> statement-breakpoint
CREATE INDEX "signature_requests_creator_idx" ON "signature_requests" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "signature_requests_status_idx" ON "signature_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_wallets_user_id_idx" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_wallets_public_key_idx" ON "user_wallets" USING btree ("public_key_hex");--> statement-breakpoint
CREATE UNIQUE INDEX "user_wallets_user_key_uq" ON "user_wallets" USING btree ("user_id","public_key_hex");