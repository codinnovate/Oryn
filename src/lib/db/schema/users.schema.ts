import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, primaryId, updatedAt } from "./_shared";

export const userStatusEnum = pgEnum("user_status", [
  "active",
  "suspended",
  "deleted",
]);

export const verificationTokenTypeEnum = pgEnum("verification_token_type", [
  "verify_email",
  "password_reset",
]);

export const users = pgTable(
  "users",
  {
    id: primaryId(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    passwordHash: text("password_hash"),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    status: userStatusEnum("status").notNull().default("active"),
    isEmailVerified: boolean("is_email_verified").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    preferences: jsonb("preferences")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    // Case-insensitive uniqueness on email via normalized column.
    uniqueIndex("users_email_normalized_uq").on(table.emailNormalized),
    index("users_status_idx").on(table.status),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: primaryId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: verificationTokenTypeEnum("type").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("verification_tokens_token_hash_uq").on(table.tokenHash),
    index("verification_tokens_user_id_idx").on(table.userId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  verificationTokens: many(verificationTokens),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type VerificationToken = typeof verificationTokens.$inferSelect;
