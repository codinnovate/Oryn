import { and, eq } from "drizzle-orm";
import { Inject, Injectable } from "@nestjs/common";
import { getDb } from "@/lib/db/database";
import {
  emailAccounts,
  scheduledEmails,
  PermissionKeys,
  type ScheduledEmail,
} from "@/lib/db/schema";
import { ApiError } from "@/lib/http/api-error";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { QueueService } from "@/lib/queue/queue.service";
import type { ProviderId } from "@/providers/types";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { EmailAccountsService } from "@/modules/email-accounts/email-accounts.service";
import { RbacService } from "@/modules/rbac/rbac.service";
import type { SendMessageBody, ScheduleEmailBody } from "@/modules/messaging/schemas";

export interface PublicScheduledEmail {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  scheduledFor: string | null;
  status: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}

@Injectable()
export class MessagingService {
  private readonly db = getDb();

  constructor(
    private readonly accounts: EmailAccountsService,
    private readonly rbac: RbacService,
    private readonly queue: QueueService,
    @Inject(EMAIL_PROVIDER_ADAPTERS) private readonly adapters: EmailProviderAdapters,
  ) {}

  /** Enqueues an immediate send; returns the local id + job id. */
  async sendEmail(
    actorUserId: string,
    workspaceId: string,
    accountId: string,
    input: SendMessageBody,
  ): Promise<{ id: string; jobId: string }> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsSend);
    const account = await this.findActiveAccount(workspaceId, accountId);

    const [row] = await this.db
      .insert(scheduledEmails)
      .values({
        workspaceId,
        emailAccountId: account.id,
        to: input.to.join(", "),
        cc: input.cc?.join(", ") ?? null,
        bcc: input.bcc?.join(", ") ?? null,
        subject: input.subject,
        bodyText: input.text ?? null,
        bodyHtml: input.html ?? null,
        status: "pending",
      })
      .returning({ id: scheduledEmails.id });

    const jobId = await this.queue.enqueue(
      QUEUE_NAMES.emailSend,
      "send-email",
      { scheduledEmailId: row!.id },
    );
    return { id: row!.id, jobId };
  }

  /** Enqueues a scheduled send; BullMQ delays the job until scheduledFor. */
  async scheduleEmail(
    actorUserId: string,
    workspaceId: string,
    accountId: string,
    input: ScheduleEmailBody,
  ): Promise<{ id: string; jobId: string }> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsSend);
    const account = await this.findActiveAccount(workspaceId, accountId);

    const [row] = await this.db
      .insert(scheduledEmails)
      .values({
        workspaceId,
        emailAccountId: account.id,
        to: input.to.join(", "),
        cc: input.cc?.join(", ") ?? null,
        bcc: input.bcc?.join(", ") ?? null,
        subject: input.subject,
        bodyText: input.text ?? null,
        bodyHtml: input.html ?? null,
        scheduledFor: input.scheduledFor,
        status: "pending",
      })
      .returning({ id: scheduledEmails.id });

    const delayMs = input.scheduledFor.getTime() - Date.now();
    const jobId = await this.queue.enqueue(
      QUEUE_NAMES.emailSend,
      "send-email",
      { scheduledEmailId: row!.id },
      { delay: Math.max(delayMs, 0) },
    );
    return { id: row!.id, jobId };
  }

  /** Cancels a pending scheduled email. Cannot cancel already-sent emails. */
  async cancelEmail(
    actorUserId: string,
    workspaceId: string,
    messageId: string,
  ): Promise<void> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsSend);
    const [updated] = await this.db
      .update(scheduledEmails)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(scheduledEmails.id, messageId),
          eq(scheduledEmails.workspaceId, workspaceId),
          eq(scheduledEmails.status, "pending"),
        ),
      )
      .returning({ id: scheduledEmails.id });
    if (!updated) throw ApiError.notFound("Pending email not found or already sent");
  }

  /** Lists pending scheduled emails for an account. */
  async listPending(
    actorUserId: string,
    workspaceId: string,
    accountId: string,
  ): Promise<PublicScheduledEmail[]> {
    await this.rbac.requirePermission(actorUserId, workspaceId, PermissionKeys.EmailsRead);
    const rows = await this.db
      .select()
      .from(scheduledEmails)
      .where(
        and(
          eq(scheduledEmails.emailAccountId, accountId),
          eq(scheduledEmails.workspaceId, workspaceId),
          eq(scheduledEmails.status, "pending"),
        ),
      )
      .orderBy(scheduledEmails.scheduledFor);
    return rows.map(toPublic);
  }

  /**
   * Executes the actual send via the provider adapter. Called by the
   * email-send BullMQ processor.
   */
  async runSend(scheduledEmailId: string): Promise<{ providerMessageId: string }> {
    const rows = await this.db
      .select()
      .from(scheduledEmails)
      .where(eq(scheduledEmails.id, scheduledEmailId))
      .limit(1);
    const email = rows[0];
    if (!email) throw new Error(`Scheduled email ${scheduledEmailId} not found`);
    if (email.status !== "pending") return { providerMessageId: "" };

    const account = await this.accounts.findById(email.emailAccountId);
    if (!account || account.status !== "active") {
      await this.markFailed(email.id, "Email account is not active");
      return { providerMessageId: "" };
    }

    let accessToken: string;
    try {
      accessToken = await this.accounts.getValidAccessToken(account);
    } catch (err) {
      await this.markFailed(email.id, err instanceof Error ? err.message : "Token refresh failed");
      throw err;
    }

    const adapter = this.adapters[account.provider as ProviderId];
    if (!adapter) {
      await this.markFailed(email.id, `Unknown provider ${account.provider}`);
      return { providerMessageId: "" };
    }

    try {
      const result = await adapter.sendMessage(accessToken, {
        to: email.to.split(","),
        cc: email.cc ? email.cc.split(",") : undefined,
        bcc: email.bcc ? email.bcc.split(",") : undefined,
        subject: email.subject,
        text: email.bodyText ?? undefined,
        html: email.bodyHtml ?? undefined,
      });

      await this.db
        .update(scheduledEmails)
        .set({
          status: "sent",
          providerMessageId: result.providerMessageId || null,
          sentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(scheduledEmails.id, email.id));

      return { providerMessageId: result.providerMessageId };
    } catch (err) {
      await this.markFailed(
        email.id,
        err instanceof Error ? err.message : "Send failed",
      );
      throw err;
    }
  }

  private async markFailed(id: string, message: string) {
    await this.db
      .update(scheduledEmails)
      .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
      .where(eq(scheduledEmails.id, id));
  }

  async findActiveAccount(workspaceId: string, accountId: string) {
    const rows = await this.db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.workspaceId, workspaceId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw ApiError.notFound("Email account not found");
    if (row.status !== "active") {
      throw new ApiError(
        "EMAIL_ACCOUNT_NOT_CONNECTED",
        "The mailbox is not connected; reconnect it before sending",
        { status: 409 },
      );
    }
    return row;
  }
}

function toPublic(row: ScheduledEmail): PublicScheduledEmail {
  return {
    id: row.id,
    to: row.to.split(","),
    cc: row.cc ? row.cc.split(",") : [],
    bcc: row.bcc ? row.bcc.split(",") : [],
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    status: row.status,
    providerMessageId: row.providerMessageId,
    errorMessage: row.errorMessage,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
