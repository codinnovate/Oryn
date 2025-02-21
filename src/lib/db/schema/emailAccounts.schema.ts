import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId, updatedAt } from "./_shared";

/**
 * An email account (Gmail or Outlook mailbox) connected to a workspace via
 * OAuth. Provider tokens are stored AES-256-GCM encrypted at rest and are
 * never returned by the API.
 */
export const emailAccounts = pgTable(
  "email_accounts",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id").notNull(),
    connectedByUserId: uuid("connected_by_user_id").notNull(),
    /** "gmail" | "outlook" — validated in application schemas. */
    provider: text("provider").notNull(),
    /** Stable id at the provider (Google `sub` / Microsoft Graph `id`). */
    providerAccountId: text("provider_account_id").notNull(),
    emailAddress: text("email_address").notNull(),
    displayName: text("display_name"),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    /** Granted scopes as reported by the provider. */
    scope: text("scope"),
    /** When the access token expires; refreshed lazily on use. */
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    /** "active" | "revoked" | "error" */
    status: text("status").notNull().default("active"),
    statusMessage: text("status_message"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("email_accounts_workspace_provider_account_uq").on(
      table.workspaceId,
      table.provider,
      table.providerAccountId,
    ),
    index("email_accounts_workspace_idx").on(table.workspaceId),
  ],
);

export type EmailAccount = typeof emailAccounts.$inferSelect;
export type NewEmailAccount = typeof emailAccounts.$inferInsert;
