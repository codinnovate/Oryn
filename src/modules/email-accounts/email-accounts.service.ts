import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { getDb } from "@/lib/db/database";
import {
  emailAccounts,
  PermissionKeys,
  type EmailAccount,
} from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { randomToken } from "@/lib/crypto/tokens";
import { ApiError } from "@/lib/http/api-error";
import { signOAuthState, verifyOAuthState } from "@/lib/oauth/state";
import type { AuditEntry } from "@/modules/audit/audit.service";
import { AuditService } from "@/modules/audit/audit.service";
import { RbacService } from "@/modules/rbac/rbac.service";
import {
  EMAIL_PROVIDER_ADAPTERS,
  type EmailProviderAdapters,
} from "@/providers/provider.factory";
import { ProviderError, type EmailProviderAdapter, type ProviderId } from "@/providers/types";
import type { OAuthCallbackQuery } from "@/modules/email-accounts/schemas";

/** Access tokens are refreshed this many seconds before actual expiry. */
const EXPIRY_SKEW_SEC = 60;

/** Public shape of a connected account — never includes token material. */
export interface PublicEmailAccount {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  statusMessage: string | null;
  connectedByUserId: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

/**
 * Connects Gmail/Outlook mailboxes to workspaces via OAuth. All provider
 * interaction goes through EmailProviderAdapter implementations; token
 * material is encrypted at rest and never leaves this service.
 */
@Injectable()
export class EmailAccountsService {
  private readonly db = getDb();

  constructor(
    @Inject(EMAIL_PROVIDER_ADAPTERS) private readonly adapters: EmailProviderAdapters,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Builds the consent URL for connecting a provider mailbox. The signed
   * state binds the browser round-trip to (user, workspace, provider).
   */
  async startConnection(
    actorUserId: string,
    workspaceId: string,
    providerId: ProviderId,
  ): Promise<{ authorizationUrl: string }> {
    await this.rbac.requirePermission(
      actorUserId,
      workspaceId,
      PermissionKeys.EmailAccountsManage,
    );
    const adapter = this.adapter(providerId);
    if (!adapter.isConfigured()) {
      throw new ApiError(
        "PROVIDER_UNAVAILABLE",
        `${adapter.displayName} sign-in is not configured`,
        { status: 503 },
      );
    }
    const state = signOAuthState({
      provider: providerId,
      userId: actorUserId,
      workspaceId,
      nonce: randomToken(16),
      iat: Date.now(),
    });
    return {
      authorizationUrl: adapter.buildAuthorizationUrl({
        state,
        redirectUri: this.redirectUri(workspaceId, providerId),
      }),
    };
  }

  /**
   * Completes the OAuth round trip: validates state, exchanges the code,
   * resolves the mailbox identity, and upserts an encrypted account record.
   * Public endpoint — authorization comes from the signed state alone.
   */
  async handleCallback(
    providerId: ProviderId,
    query: OAuthCallbackQuery,
  ): Promise<PublicEmailAccount> {
    if (query.error) {
      throw ApiError.validation(`The provider reported: ${query.error}`);
    }
    const verified = verifyOAuthState(query.state!);
    if (!verified.ok || verified.state.provider !== providerId) {
      throw new ApiError("OAUTH_STATE_INVALID", "Invalid or expired OAuth state", {
        status: 400,
      });
    }
    const { userId, workspaceId } = verified.state;
    const adapter = this.adapter(providerId);

    const tokens = await this.exchange(adapter, query.code!, workspaceId);
    const profile = await this.resolveProfile(adapter, tokens.accessToken);

    const expiresAt =
      tokens.expiresInSec != null
        ? new Date(Date.now() + tokens.expiresInSec * 1000)
        : null;
    const accessTokenCiphertext = encryptSecret(tokens.accessToken, "access-token");
    const refreshTokenCiphertext = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken, "refresh-token")
      : null;

    const [row] = await this.db
      .insert(emailAccounts)
      .values({
        workspaceId,
        connectedByUserId: userId,
        provider: providerId,
        providerAccountId: profile.providerAccountId,
        emailAddress: profile.emailAddress,
        displayName: profile.displayName ?? null,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        scope: tokens.scope ?? null,
        accessTokenExpiresAt: expiresAt,
        status: "active",
        statusMessage: null,
      })
      .onConflictDoUpdate({
        target: [
          emailAccounts.workspaceId,
          emailAccounts.provider,
          emailAccounts.providerAccountId,
        ],
        set: {
          connectedByUserId: userId,
          emailAddress: profile.emailAddress,
          displayName: profile.displayName ?? null,
          accessTokenCiphertext,
          // Providers may omit the refresh token on re-consent — keep the old one.
          refreshTokenCiphertext: sql`coalesce(excluded.refresh_token_ciphertext, ${emailAccounts.refreshTokenCiphertext})`,
          scope: tokens.scope ?? null,
          accessTokenExpiresAt: expiresAt,
          status: "active",
          statusMessage: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error("email_account_upsert_failed");
    this.recordEvent({
      workspaceId,
      actorUserId: userId,
      action: "email_account.connected",
      targetType: "email_account",
      targetId: row.id,
      metadata: { provider: providerId, emailAddress: profile.emailAddress },
    });
    return toPublic(row);
  }

  async listForWorkspace(
    actorUserId: string,
    workspaceId: string,
  ): Promise<PublicEmailAccount[]> {
    await this.rbac.requireMembership(actorUserId, workspaceId);
    const rows = await this.db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.workspaceId, workspaceId))
      .orderBy(desc(emailAccounts.createdAt));
    return rows.map(toPublic);
  }

  async disconnect(
    actorUserId: string,
    workspaceId: string,
    accountId: string,
  ): Promise<void> {
    await this.rbac.requirePermission(
      actorUserId,
      workspaceId,
      PermissionKeys.EmailAccountsManage,
    );
    const deleted = await this.db
      .delete(emailAccounts)
      .where(
        and(eq(emailAccounts.id, accountId), eq(emailAccounts.workspaceId, workspaceId)),
      )
      .returning({ id: emailAccounts.id, provider: emailAccounts.provider });
    const removed = deleted[0];
    if (!removed) throw ApiError.notFound("Email account not found");
    this.recordEvent({
      workspaceId,
      actorUserId,
      action: "email_account.disconnected",
      targetType: "email_account",
      targetId: removed.id,
      metadata: { provider: removed.provider },
    });
  }

  /**
   * Returns a usable access token, refreshing it when close to expiry.
   * Used by sync/send flows; maps provider failures to stable error codes.
   */
  async getValidAccessToken(account: EmailAccount): Promise<string> {
    const expired =
      !account.accessTokenExpiresAt ||
      account.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_SEC * 1000 <= Date.now();
    if (!expired && account.status === "active") {
      return decryptSecret(account.accessTokenCiphertext, "access-token");
    }

    if (!account.refreshTokenCiphertext) {
      throw new ApiError(
        "EMAIL_ACCOUNT_NOT_CONNECTED",
        "The email account has no refreshable credentials",
        { status: 409 },
      );
    }
    const adapter = this.adapter(account.provider as ProviderId);
    const refreshToken = decryptSecret(account.refreshTokenCiphertext, "refresh-token");

    let tokens;
    try {
      tokens = await adapter.refresh(refreshToken);
    } catch (err) {
      await this.markStatus(account, err);
      throw this.translateRefreshError(err);
    }

    const accessTokenCiphertext = encryptSecret(tokens.accessToken, "access-token");
    const expiresAt =
      tokens.expiresInSec != null
        ? new Date(Date.now() + tokens.expiresInSec * 1000)
        : null;
    await this.db
      .update(emailAccounts)
      .set({
        accessTokenCiphertext,
        refreshTokenCiphertext: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken, "refresh-token")
          : account.refreshTokenCiphertext,
        accessTokenExpiresAt: expiresAt,
        status: "active",
        statusMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(emailAccounts.id, account.id));
    return tokens.accessToken;
  }

  /** Loads an account for internal flows (jobs), enforcing tenancy upstream. */
  async findById(accountId: string): Promise<EmailAccount | null> {
    const rows = await this.db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, accountId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async exchange(
    adapter: EmailProviderAdapter,
    code: string,
    workspaceId: string,
  ) {
    try {
      return await adapter.exchangeCode(code, this.redirectUri(workspaceId, adapter.id));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "invalid_grant") {
        // Authorization codes are single-use and short-lived; treat as user error.
        throw ApiError.validation("The authorization code is invalid or expired");
      }
      throw this.translateUnavailable(err);
    }
  }

  private async resolveProfile(adapter: EmailProviderAdapter, accessToken: string) {
    try {
      return await adapter.getProfile(accessToken);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "invalid_grant") {
        throw ApiError.validation("The access token was rejected by the provider");
      }
      throw this.translateUnavailable(err);
    }
  }

  private markStatus(account: EmailAccount, cause: unknown): Promise<unknown> {
    const message =
      cause instanceof ProviderError ? cause.message : "Token refresh failed";
    return this.db
      .update(emailAccounts)
      .set({
        status: cause instanceof ProviderError && cause.kind === "invalid_grant" ? "revoked" : "error",
        statusMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(emailAccounts.id, account.id));
  }

  private translateRefreshError(err: unknown): ApiError {
    if (err instanceof ProviderError) {
      if (err.kind === "rate_limited") {
        return new ApiError("PROVIDER_RATE_LIMITED", err.message, { status: 429 });
      }
      if (err.kind === "invalid_grant") {
        return new ApiError(
          "OAUTH_TOKEN_EXPIRED",
          "The connection has been revoked; reconnect the account",
          { status: 401 },
        );
      }
    }
    return new ApiError("PROVIDER_UNAVAILABLE", "The email provider is unreachable", {
      status: 503,
      cause: err,
    });
  }

  private translateUnavailable(err: unknown): ApiError {
    if (err instanceof ProviderError && err.kind === "rate_limited") {
      return new ApiError("PROVIDER_RATE_LIMITED", err.message, { status: 429 });
    }
    return new ApiError("PROVIDER_UNAVAILABLE", "The email provider request failed", {
      status: 503,
      cause: err,
    });
  }

  private adapter(providerId: ProviderId): EmailProviderAdapter {
    const adapter = this.adapters[providerId];
    if (!adapter) {
      throw ApiError.validation(`Unknown email provider: ${providerId}`);
    }
    return adapter;
  }

  private redirectUri(workspaceId: string, providerId: ProviderId): string {
    return `${getEnv().APP_URL}/api/v1/workspaces/${workspaceId}/email-accounts/oauth/${providerId}/callback`;
  }

  private recordEvent(entry: AuditEntry): void {
    void this.audit.record(entry);
  }
}

export function toPublic(row: EmailAccount): PublicEmailAccount {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    displayName: row.displayName,
    status: row.status,
    statusMessage: row.statusMessage,
    connectedByUserId: row.connectedByUserId,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
