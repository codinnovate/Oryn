import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, primaryId } from "./_shared";

/**
 * Append-only audit trail. Workspace-scoped when the action happened inside a
 * workspace; null workspaceId for account-level events (auth flows).
 * Rows are never updated or deleted by application code.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: primaryId(),
    workspaceId: uuid("workspace_id"),
    actorUserId: uuid("actor_user_id"),
    // Dotted namespaced action, e.g. "workspace.created", "member.removed".
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("audit_logs_actor_idx").on(table.actorUserId),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
