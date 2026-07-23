CREATE TABLE "billing_deposits" (
	"tx_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount_motes" text NOT NULL,
	"from_public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"cost_motes" text NOT NULL,
	"settled_tx_hash" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "billing_deposits_user_idx" ON "billing_deposits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_user_idx" ON "usage_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_unsettled_idx" ON "usage_ledger" USING btree ("user_id") WHERE "usage_ledger"."settled_tx_hash" is null;