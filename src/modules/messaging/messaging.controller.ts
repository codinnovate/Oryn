import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { MessagingService } from "@/modules/messaging/messaging.service";
import {
  sendMessageBodySchema,
  scheduleEmailBodySchema,
  type SendMessageBody,
  type ScheduleEmailBody,
} from "@/modules/messaging/schemas";

@ApiTags("messaging")
@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post("workspaces/:workspaceId/email-accounts/:accountId/messages/send")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Send an email immediately (emails:send)" })
  async send(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @Body(new ZodValidationPipe(sendMessageBodySchema)) body: SendMessageBody,
    @CurrentUser() user?: { id: string },
  ) {
    const result = await this.messaging.sendEmail(user!.id, workspaceId, accountId, body);
    return { data: result };
  }

  @Post("workspaces/:workspaceId/email-accounts/:accountId/messages/schedule")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Schedule an email for future delivery (emails:send)" })
  async schedule(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @Body(new ZodValidationPipe(scheduleEmailBodySchema)) body: ScheduleEmailBody,
    @CurrentUser() user?: { id: string },
  ) {
    const result = await this.messaging.scheduleEmail(user!.id, workspaceId, accountId, body);
    return { data: result };
  }

  @Delete("workspaces/:workspaceId/email-accounts/:accountId/messages/:messageId")
  @ApiOperation({ summary: "Cancel a pending scheduled email (emails:send)" })
  async cancel(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.messaging.cancelEmail(user!.id, workspaceId, messageId);
    return { data: { cancelled: true } };
  }

  @Get("workspaces/:workspaceId/email-accounts/:accountId/messages/scheduled")
  @ApiOperation({ summary: "List pending scheduled emails (emails:read)" })
  async listPending(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("accountId", new ZodValidationPipe(uuidParamSchema)) accountId: string,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.messaging.listPending(user!.id, workspaceId, accountId),
    };
  }
}
