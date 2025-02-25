CREATE TABLE "scheduled_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_account_id" uuid NOT NULL,
	"to" text NOT NULL,
	"cc" text,
	"bcc" text,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text,
	"body_html" text,
	"scheduled_for" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduled_emails_workspace_status_idx" ON "scheduled_emails" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "scheduled_emails_scheduled_for_idx" ON "scheduled_emails" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_emails_account_idx" ON "scheduled_emails" USING btree ("email_account_id");