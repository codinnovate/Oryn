import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt } from "./_shared";

/**
 * Outbound email queued for sending (immediate or scheduled). Rows are
 * created by the API and consumed by the email-send BullMQ processor.
 * Status lifecycle: pending → sent | failed | cancelled.
 */
export const scheduledEmails = pgTable(
  "scheduled_emails",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id").notNull(),
    emailAccountId: uuid("email_account_id").notNull(),
    /** Recipient addresses (newline-separated or comma-separated normalized). */
    to: text("to").notNull(),
    cc: text("cc"),
    bcc: text("bcc"),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    /** When to send; null means immediate. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    /** "pending" | "sent" | "failed" | "cancelled" */
    status: text("status").notNull().default("pending"),
    /** Provider-assigned id after successful send. */
    providerMessageId: text("provider_message_id"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("scheduled_emails_workspace_status_idx").on(table.workspaceId, table.status),
    index("scheduled_emails_scheduled_for_idx").on(table.scheduledFor),
    index("scheduled_emails_account_idx").on(table.emailAccountId),
  ],
);

export type ScheduledEmail = typeof scheduledEmails.$inferSelect;
export type NewScheduledEmail = typeof scheduledEmails.$inferInsert;
