import { relations, sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.schema";
import { createdAt, deletedAt, primaryId, updatedAt } from "./_shared";

export const memberStatusEnum = pgEnum("member_status", [
  "invited",
  "active",
  "suspended",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const workspaces = pgTable(
  "workspaces",
  {
    id: primaryId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    plan: text("plan").notNull().default("free"),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex("workspaces_slug_uq").on(table.slug),
    index("workspaces_owner_idx").on(table.ownerId),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: memberStatusEnum("status").notNull().default("active"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A user can only occupy one membership slot per workspace.
    uniqueIndex("workspace_members_ws_user_uq").on(
      table.workspaceId,
      table.userId,
    ),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    emailNormalized: text("email_normalized").notNull(),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_uq").on(table.tokenHash),
    // One pending invitation per (workspace, email).
    uniqueIndex("invitations_pending_uq")
      .on(table.workspaceId, table.emailNormalized)
      .where(sql`${table.status} = 'pending'`),
    index("invitations_workspace_idx").on(table.workspaceId),
  ],
);

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  members: many(workspaceMembers),
  invitations: many(invitations),
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userId],
    references: [users.id],
  }),
}));

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
