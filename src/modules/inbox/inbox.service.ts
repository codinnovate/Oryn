import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { Injectable } from "@nestjs/common";
import { getDb } from "@/lib/db/database";
import { emailMessages, PermissionKeys, type EmailMessage } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";
import { RbacService } from "@/modules/rbac/rbac.service";
import type { MessageListQuery, MessageUpdateBody } from "@/modules/inbox/schemas";

export interface PublicMessage {
  id: string;
  emailAccountId: string;
  providerMessageId: string;
  threadProviderId: string | null;
  subject: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  snippet: string | null;
  direction: string;
  isRead: boolean;
  hasAttachments: boolean;
  sizeBytes: number | null;
  labels: string[];
  receivedAt: string | null;
  createdAt: string;
}

@Injectable()
export class InboxService {
  private readonly db = getDb();

  constructor(private readonly rbac: RbacService) {}

  /**
   * Paginated, filterable list of synced messages in a workspace.
   * Requires emails:read; tenancy is enforced via workspaceId.
   */
  async listMessages(
    actorUserId: string,
    workspaceId: string,
    query: MessageListQuery,
  ): Promise<{ items: PublicMessage[]; total: number }> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);

    const conditions = this.buildConditions(workspaceId, query);
    const where = and(...conditions);
    const { page, limit, sort } = query;
    const offset = (page - 1) * limit;

    const orderClause =
      sort === "-receivedAt" ? desc(emailMessages.receivedAt) : sql`${emailMessages.receivedAt} asc nulls last`;

    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(emailMessages)
        .where(where)
        .orderBy(orderClause)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ value: count() })
        .from(emailMessages)
        .where(where),
    ]);

    return {
      items: rows.map(toPublic),
      total: totals[0]?.value ?? 0,
    };
  }

  /** Single message detail. Returns 404 when not found or outside the workspace. */
  async getMessage(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
  ): Promise<PublicMessage> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const row = await this.db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.id, messageId), eq(emailMessages.workspaceId, workspaceId)))
      .limit(1);
    const msg = row[0];
    if (!msg) throw ApiError.notFound("Message not found");
    return toPublic(msg);
  }

  /**
   * Patches mutable flags (isRead, labels) on a single message.
   * Requires emails:write.
   */
  async updateMessage(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
    patch: MessageUpdateBody,
  ): Promise<PublicMessage> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsWrite);

    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.isRead !== undefined) sets.isRead = patch.isRead;
    if (patch.labels !== undefined) sets.labels = patch.labels;

    const [updated] = await this.db
      .update(emailMessages)
      .set(sets)
      .where(and(eq(emailMessages.id, messageId), eq(emailMessages.workspaceId, workspaceId)))
      .returning();

    if (!updated) throw ApiError.notFound("Message not found");
    return toPublic(updated);
  }

  private buildConditions(workspaceId: string, query: MessageListQuery) {
    const conditions = [eq(emailMessages.workspaceId, workspaceId)];

    if (query.emailAccountId) {
      conditions.push(eq(emailMessages.emailAccountId, query.emailAccountId));
    }

    if (query.isRead !== undefined) {
      conditions.push(eq(emailMessages.isRead, query.isRead));
    }

    if (query.direction) {
      conditions.push(eq(emailMessages.direction, query.direction));
    }

    if (query.q) {
      const pattern = `%${query.q}%`;
      conditions.push(ilike(emailMessages.subject, pattern));
    }

    if (query.receivedAfter) {
      conditions.push(sql`${emailMessages.receivedAt} >= ${query.receivedAfter}`);
    }

    if (query.receivedBefore) {
      conditions.push(sql`${emailMessages.receivedAt} < ${query.receivedBefore}`);
    }

    return conditions;
  }
}

function toPublic(row: EmailMessage): PublicMessage {
  return {
    id: row.id,
    emailAccountId: row.emailAccountId,
    providerMessageId: row.providerMessageId,
    threadProviderId: row.threadProviderId,
    subject: row.subject,
    fromAddress: row.fromAddress,
    toAddresses: (row.toAddresses as string[]) ?? [],
    snippet: row.snippet,
    direction: row.direction,
    isRead: row.isRead,
    hasAttachments: row.hasAttachments,
    sizeBytes: row.sizeBytes,
    labels: (row.labels as string[]) ?? [],
    receivedAt: row.receivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
