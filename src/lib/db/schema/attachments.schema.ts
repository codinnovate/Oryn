import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId } from "./_shared";

/**
 * An attachment metadata row linked to a synced email message. The actual
 * bytes are never stored in Postgres — they are fetched on-demand from the
 * provider and streamed to the client. This table caches the metadata
 * (filename, MIME type, size) so the inbox can list attachments without
 * calling the provider every time.
 */
export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: primaryId(),
    messageId: uuid("message_id").notNull(),
    /** Stable id at the provider (Gmail part id / Graph attachment id). */
    providerAttachmentId: text("provider_attachment_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** SHA-256 of the attachment content, computed once on first download. */
    contentHash: text("content_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    index("email_attachments_message_idx").on(table.messageId),
  ],
);

export type EmailAttachment = typeof emailAttachments.$inferSelect;
export type NewEmailAttachment = typeof emailAttachments.$inferInsert;
