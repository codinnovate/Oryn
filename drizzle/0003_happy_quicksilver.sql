CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"thread_provider_id" text,
	"subject" text,
	"from_address" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snippet" text,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"size_bytes" integer,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_account_provider_uq" UNIQUE("email_account_id","provider_message_id")
);
--> statement-breakpoint
CREATE INDEX "email_messages_workspace_received_idx" ON "email_messages" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "email_messages_account_idx" ON "email_messages" USING btree ("email_account_id");