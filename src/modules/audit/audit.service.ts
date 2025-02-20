import { Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { getDb } from "@/lib/db/database";
import { auditLogs, workspaceMembers, workspaces, type NewAuditLog } from "@/lib/db/schema";
import { getLogger } from "@/lib/logger";

export type AuditEntry = Omit<NewAuditLog, "id" | "createdAt">;

/**
 * Append-only audit trail writer/reader. Recording never throws: an audit
 * outage must not break the business operation it observes.
 */
@Injectable()
export class AuditService {
  private readonly db = getDb();

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values(entry);
    } catch (err) {
      getLogger().error({ err, action: entry.action }, "audit_write_failed");
    }
  }

  /**
   * Lists a workspace's audit trail. Callers must already hold
   * audit_logs:read; this method only enforces tenancy.
   */
  async listForWorkspace(
    workspaceId: string,
    opts: { limit: number; offset: number; action?: string },
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const conditions = [eq(auditLogs.workspaceId, workspaceId)];
    if (opts.action) {
      conditions.push(like(auditLogs.action, `${opts.action}%`));
    }
    const where = and(...conditions);

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);

    const totals = await this.db
      .select({ value: count() })
      .from(auditLogs)
      .where(where);

    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
    };
  }

  /** Cross-workspace trail for the actor's own actions. */
  async listForActor(
    userId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    // Actor's own entries plus entries in workspaces they still belong to.
    const memberWs = this.db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)),
      );

    const wsIds = (await memberWs).map((r) => r.id);
    const scope = wsIds.length
      ? or(
          eq(auditLogs.actorUserId, userId),
          inArray(auditLogs.workspaceId, wsIds),
        )
      : eq(auditLogs.actorUserId, userId);

    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(scope)
      .orderBy(desc(auditLogs.createdAt))
      .limit(opts.limit)
      .offset(opts.offset);

    const totals = await this.db
      .select({ value: count() })
      .from(auditLogs)
      .where(scope);

    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorUserId: r.actorUserId,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
    };
  }
}
