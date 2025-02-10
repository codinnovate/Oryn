import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMembers, workspaces } from "./workspaces.schema";
import { createdAt, updatedAt } from "./_shared";

/**
 * Permissions are global capability keys (e.g. "emails:read").
 * Roles are per-workspace bundles of permissions; system roles
 * (owner/admin/member) are seeded automatically on workspace creation.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("permissions_key_uq").on(table.key)],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // null = global role template (future use); non-null = workspace-scoped.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("roles_workspace_key_uq").on(table.workspaceId, table.key),
    index("roles_workspace_idx").on(table.workspaceId),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("role_permissions_role_idx").on(table.roleId),
  ],
);

export const memberRoles = pgTable(
  "member_roles",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.roleId] }),
    index("member_roles_role_idx").on(table.roleId),
  ],
);

export const rolesRelations = relations(roles, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [roles.workspaceId],
    references: [workspaces.id],
  }),
  rolePermissions: many(rolePermissions),
}));

export const workspaceMembersRelationsRbac =
  relations(workspaceMembers, ({ many }) => ({
    memberRoles: many(memberRoles),
  }));

export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
