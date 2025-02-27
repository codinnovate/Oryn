import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { Inject, Injectable } from "@nestjs/common";
import { getDb } from "@/lib/db/database";
import { emailMessages, emailAttachments, PermissionKeys, type EmailMessage } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";
import { RbacService } from "@/modules/rbac/rbac.service";
import { EmailAccountsService } from "@/modules/email-accounts/email-accounts.service";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import type { ProviderId } from "@/providers/types";
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

export interface MessageBody {
  text: string | null;
  html: string | null;
}

export interface PublicAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
}

@Injectable()
export class InboxService {
  private readonly db = getDb();

  constructor(
    private readonly rbac: RbacService,
    private readonly accounts: EmailAccountsService,
    @Inject(EMAIL_PROVIDER_ADAPTERS) private readonly adapters: EmailProviderAdapters,
  ) {}

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
    const row = await this.findMessage(workspaceId, messageId);
    return toPublic(row);
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

  /**
   * Lazily fetches the message body from the provider and caches it in
   * the email_messages table. Subsequent calls return the cached version.
   */
  async getMessageBody(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
  ): Promise<MessageBody> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const msg = await this.findMessage(workspaceId, messageId);

    // Already cached
    if (msg.bodyText || msg.bodyHtml) {
      return { text: msg.bodyText, html: msg.bodyHtml };
    }

    const { adapter, accessToken } = await this.getProvider(msg.emailAccountId);
    const body = await adapter.fetchMessageBody(accessToken, msg.providerMessageId);

    await this.db
      .update(emailMessages)
      .set({ bodyText: body.text ?? null, bodyHtml: body.html ?? null, updatedAt: new Date() })
      .where(eq(emailMessages.id, msg.id));

    return { text: body.text ?? null, html: body.html ?? null };
  }

  /**
   * Lists attachment metadata for a message. On first call, fetches from
   * the provider and caches rows in email_attachments; subsequent calls
   * read from the cache.
   */
  async listAttachments(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
  ): Promise<PublicAttachment[]> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const msg = await this.findMessage(workspaceId, messageId);

    // Check cache first
    const cached = await this.db
      .select()
      .from(emailAttachments)
      .where(eq(emailAttachments.messageId, msg.id));

    if (cached.length > 0) {
      return cached.map(toPublicAttachment);
    }

    // Fetch from provider and cache
    const { adapter, accessToken } = await this.getProvider(msg.emailAccountId);
    const providerAttachments = await adapter.listAttachments(accessToken, msg.providerMessageId);

    if (providerAttachments.length === 0) return [];

    const inserted = await this.db
      .insert(emailAttachments)
      .values(
        providerAttachments.map((a) => ({
          messageId: msg.id,
          providerAttachmentId: a.providerAttachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })),
      )
      .returning();

    return inserted.map(toPublicAttachment);
  }

  /**
   * Downloads a single attachment by streaming it from the provider.
   * Returns the raw buffer + metadata for the caller to stream to the client.
   */
  async getAttachment(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const msg = await this.findMessage(workspaceId, messageId);

    // Look up the attachment row
    const [att] = await this.db
      .select()
      .from(emailAttachments)
      .where(and(eq(emailAttachments.id, attachmentId), eq(emailAttachments.messageId, msg.id)))
      .limit(1);

    if (!att) throw ApiError.notFound("Attachment not found");

    const { adapter, accessToken } = await this.getProvider(msg.emailAccountId);
    const buffer = await adapter.getAttachment(accessToken, msg.providerMessageId, att.providerAttachmentId);

    return { buffer, filename: att.filename, mimeType: att.mimeType };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async findMessage(workspaceId: string, messageId: string) {
    const [row] = await this.db
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.id, messageId), eq(emailMessages.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw ApiError.notFound("Message not found");
    return row;
  }

  private async getProvider(emailAccountId: string) {
    const account = await this.accounts.findById(emailAccountId);
    if (!account || account.status !== "active") {
      throw new ApiError(
        "EMAIL_ACCOUNT_NOT_CONNECTED",
        "The mailbox is not connected; reconnect it before fetching",
        { status: 409 },
      );
    }
    const accessToken = await this.accounts.getValidAccessToken(account);
    const adapter = this.adapters[account.provider as ProviderId];
    if (!adapter) throw new ApiError("PROVIDER_UNAVAILABLE", `Unknown provider ${account.provider}`);
    return { adapter, accessToken };
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

function toPublicAttachment(row: typeof emailAttachments.$inferSelect): PublicAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
  };
}
