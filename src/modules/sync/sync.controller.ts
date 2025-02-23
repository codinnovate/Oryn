import { Controller, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { SyncService } from "@/modules/sync/sync.service";

@ApiTags("sync")
@Controller()
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post("workspaces/:workspaceId/email-accounts/:accountId/sync")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      "Schedule a mailbox sync; returns a job id (emails:read). Async — poll the account's lastSyncedAt for completion.",
  })
  async requestSync(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @CurrentUser() user?: { id: string },
  ) {
    const result = await this.sync.requestSync(user!.id, workspaceId, accountId);
    return { data: result };
  }
}
