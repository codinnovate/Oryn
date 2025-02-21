CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connected_by_user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"scope" text,
	"access_token_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_accounts_workspace_provider_account_uq" UNIQUE("workspace_id","provider","provider_account_id")
);
--> statement-breakpoint
CREATE INDEX "email_accounts_workspace_idx" ON "email_accounts" USING btree ("workspace_id");