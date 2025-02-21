import { Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { ProviderId } from "@/providers/types";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { Public, CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import {
  oauthCallbackQuerySchema,
  providerIdSchema,
  type OAuthCallbackQuery,
} from "@/modules/email-accounts/schemas";
import { EmailAccountsService } from "@/modules/email-accounts/email-accounts.service";

@ApiTags("email-accounts")
@Controller()
export class EmailAccountsController {
  constructor(private readonly accounts: EmailAccountsService) {}

  @Post("workspaces/:workspaceId/email-accounts/oauth/:provider/start")
  @ApiOperation({
    summary:
      "Begin connecting a mailbox; returns the provider consent URL (email_accounts:manage)",
  })
  async start(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("provider", new ZodValidationPipe(providerIdSchema)) provider: ProviderId,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.accounts.startConnection(user!.id, workspaceId, provider),
    };
  }

  /** The browser lands here after the provider consent screen. */
  @Public()
  @Get("workspaces/:workspaceId/email-accounts/oauth/:provider/callback")
  @ApiOperation({
    summary: "OAuth redirect target; validates state and stores encrypted tokens",
  })
  async callback(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("provider", new ZodValidationPipe(providerIdSchema)) provider: ProviderId,
    @Query(new ZodValidationPipe(oauthCallbackQuerySchema))
    query: OAuthCallbackQuery,
  ) {
    // The signed state — not the URL — is the source of truth for tenancy.
    const account = await this.accounts.handleCallback(provider, query);
    return { data: account };
  }

  @Get("workspaces/:workspaceId/email-accounts")
  @ApiOperation({ summary: "List connected mailboxes (members)" })
  async list(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.accounts.listForWorkspace(user!.id, workspaceId),
    };
  }

  @Delete("workspaces/:workspaceId/email-accounts/:accountId")
  @ApiOperation({ summary: "Disconnect a mailbox (email_accounts:manage)" })
  async disconnect(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.accounts.disconnect(user!.id, workspaceId, accountId);
    return { data: { deleted: true } };
  }
}
