import { and, eq, inArray, sql } from "drizzle-orm";
import { Inject, Injectable } from "@nestjs/common";
import { getDb } from "@/lib/db/database";
import {
  emailAccounts,
  emailMessages,
  PermissionKeys,
  type EmailAccount,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { QueueService } from "@/lib/queue/queue.service";
import type { ProviderId, ProviderMessage } from "@/providers/types";
import { EmailAccountsService } from "@/modules/email-accounts/email-accounts.service";
import { RbacService } from "@/modules/rbac/rbac.service";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";

/** Upper bound of provider pages consumed per sync run. */
const MAX_PAGES_PER_RUN = 10;
const PAGE_SIZE = 50;

export interface SyncRunResult {
  emailAccountId: string;
  pagesFetched: number;
  created: number;
  updated: number;
}

/** Raised for conditions retrying can never fix (revoked grant, deleted account). */
export class NonRetryableSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableSyncError";
  }
}

/**
 * Orchestrates mailbox synchronization: the API enqueues jobs onto the
 * `email-sync` queue; workers execute `runAccountSync`. All provider
 * interaction goes through EmailProviderAdapter; message rows are upserted
 * so runs are idempotent.
 */
@Injectable()
export class SyncService {
  private readonly db = getDb();

  constructor(
    private readonly accounts: EmailAccountsService,
    private readonly rbac: RbacService,
    private readonly queue: QueueService,
    @Inject(EMAIL_PROVIDER_ADAPTERS) private readonly adapters: EmailProviderAdapters,
  ) {}

  /** Validates access and schedules a background sync; returns the job id. */
  async requestSync(
    actorUserId: string,
    workspaceId: string,
    accountId: string,
  ): Promise<{ jobId: string }> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const account = await this.findInWorkspace(workspaceId, accountId);
    if (account.status !== "active") {
      throw new ApiError(
        "EMAIL_ACCOUNT_NOT_CONNECTED",
        "The mailbox is not connected; reconnect it before syncing",
        { status: 409 },
      );
    }
    const jobId = await this.queue.enqueue(QUEUE_NAMES.emailSync, "sync-account", {
      workspaceId,
      emailAccountId: account.id,
    });
    return { jobId };
  }

  /**
   * Performs an incremental metadata sync for one account. Throws on
   * transient provider failures (BullMQ retries with backoff); permanent
   * failures raise NonRetryableSyncError.
   */
  async runAccountSync(emailAccountId: string): Promise<SyncRunResult> {
    const account = await this.accounts.findById(emailAccountId);
    if (!account || account.status === "revoked") {
      // Deleted or revoked while queued — retrying can never fix this.
      throw new NonRetryableSyncError(`Email account ${emailAccountId} is unavailable`);
    }

    let accessToken: string;
    try {
      accessToken = await this.accounts.getValidAccessToken(account);
    } catch (err) {
      if (err instanceof ApiError && err.code === "OAUTH_TOKEN_EXPIRED") {
        throw new NonRetryableSyncError("Grant was revoked; reconnect required");
      }
      throw err;
    }

    const adapter = this.adapterFor(account);
    const since = account.lastSyncedAt;

    let pageToken: string | null = null;
    let pagesFetched = 0;
    let created = 0;
    let updated = 0;

    do {
      const page = await adapter.listMessages(accessToken, {
        maxResults: PAGE_SIZE,
        pageToken,
        since,
      });
      const counts = await this.upsertPage(account, page.messages);
      created += counts.created;
      updated += counts.updated;
      pagesFetched += 1;
      pageToken = page.nextPageToken;
    } while (pageToken && pagesFetched < MAX_PAGES_PER_RUN);

    await this.db
      .update(emailAccounts)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(emailAccounts.id, account.id));

    return { emailAccountId: account.id, pagesFetched, created, updated };
  }

  private async upsertPage(
    account: EmailAccount,
    messages: ProviderMessage[],
  ): Promise<{ created: number; updated: number }> {
    if (messages.length === 0) return { created: 0, updated: 0 };

    const ids = messages.map((m) => m.providerMessageId);
    const existing = await this.db
      .select({ providerMessageId: emailMessages.providerMessageId })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.emailAccountId, account.id),
          inArray(emailMessages.providerMessageId, ids),
        ),
      );

    const rows = messages.map((m) => ({
      workspaceId: account.workspaceId,
      emailAccountId: account.id,
      providerMessageId: m.providerMessageId,
      threadProviderId: m.threadId,
      subject: m.subject,
      fromAddress: m.fromAddress,
      toAddresses: m.toAddresses,
      snippet: m.snippet,
      // Mail sent by the mailbox owner counts as outbound.
      direction:
        m.fromAddress && m.fromAddress === account.emailAddress.toLowerCase()
          ? "outbound"
          : "inbound",
      isRead: m.isRead,
      hasAttachments: m.hasAttachments,
      sizeBytes: m.sizeBytes != null ? Math.min(Math.trunc(m.sizeBytes), 2_147_483_647) : null,
      labels: m.labels,
      receivedAt: m.receivedAt,
    }));

    await this.db
      .insert(emailMessages)
      .values(rows)
      .onConflictDoUpdate({
        target: [emailMessages.emailAccountId, emailMessages.providerMessageId],
        set: {
          threadProviderId: sql`excluded.thread_provider_id`,
          subject: sql`excluded.subject`,
          fromAddress: sql`excluded.from_address`,
          toAddresses: sql`excluded.to_addresses`,
          snippet: sql`excluded.snippet`,
          direction: sql`excluded.direction`,
          isRead: sql`excluded.is_read`,
          hasAttachments: sql`excluded.has_attachments`,
          sizeBytes: sql`excluded.size_bytes`,
          labels: sql`excluded.labels`,
          receivedAt: sql`excluded.received_at`,
          updatedAt: new Date(),
        },
      });

    const existingIds = new Set(existing.map((row) => row.providerMessageId));
    return {
      created: rows.length - existingIds.size,
      updated: existingIds.size,
    };
  }

  async findInWorkspace(workspaceId: string, accountId: string): Promise<EmailAccount> {
    const rows = await this.db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.workspaceId, workspaceId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw ApiError.notFound("Email account not found");
    return row;
  }

  private adapterFor(account: EmailAccount) {
    const adapter = this.adapters[account.provider as ProviderId];
    if (!adapter) {
      throw new NonRetryableSyncError(`Unknown provider ${account.provider}`);
    }
    return adapter;
  }
}
