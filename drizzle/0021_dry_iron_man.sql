CREATE TABLE "oauth_state_nonce" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
