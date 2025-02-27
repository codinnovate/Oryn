import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt } from "./_shared";

/**
 * A mailbox message synced from a provider. Metadata is populated eagerly by
 * sync; bodies/attachments are fetched lazily by the inbox module on first
 * access. Rows are upserted on (emailAccountId, providerMessageId) so
 * repeated syncs are idempotent and flag changes (read/unread) propagate.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id").notNull(),
    emailAccountId: uuid("email_account_id").notNull(),
    /** Stable id at the provider (Gmail id / Graph id). */
    providerMessageId: text("provider_message_id").notNull(),
    threadProviderId: text("thread_provider_id"),
    subject: text("subject"),
    /** Normalized lowercase addresses; never display names. */
    fromAddress: text("from_address"),
    toAddresses: jsonb("to_addresses").notNull().default([]),
    snippet: text("snippet"),
    /** Plain text body — lazily populated on first fetch. */
    bodyText: text("body_text"),
    /** HTML body — lazily populated on first fetch. */
    bodyHtml: text("body_html"),
    /** "inbound" | "outbound" — resolved against the account address. */
    direction: text("direction").notNull().default("inbound"),
    isRead: boolean("is_read").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    sizeBytes: integer("size_bytes"),
    labels: jsonb("labels").notNull().default([]),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("email_messages_account_provider_uq").on(
      table.emailAccountId,
      table.providerMessageId,
    ),
    index("email_messages_workspace_received_idx").on(
      table.workspaceId,
      table.receivedAt,
    ),
    index("email_messages_account_idx").on(table.emailAccountId),
  ],
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;
