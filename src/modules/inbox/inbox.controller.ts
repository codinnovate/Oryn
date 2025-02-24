import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { InboxService } from "@/modules/inbox/inbox.service";
import {
  messageListQuerySchema,
  messageUpdateBodySchema,
  type MessageListQuery,
  type MessageUpdateBody,
} from "@/modules/inbox/schemas";

@ApiTags("inbox")
@Controller()
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get("workspaces/:workspaceId/messages")
  @ApiOperation({
    summary: "Paginated message list with filters (emails:read)",
  })
  async list(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Query(new ZodValidationPipe(messageListQuerySchema)) query: MessageListQuery,
    @CurrentUser() user?: { id: string },
  ) {
    const { items, total } = await this.inbox.listMessages(user!.id, workspaceId, query);
    return {
      data: items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasNextPage: query.page * query.limit < total,
        hasPreviousPage: query.page > 1,
      },
    };
  }

  @Get("workspaces/:workspaceId/messages/:messageId")
  @ApiOperation({ summary: "Single message detail (emails:read)" })
  async get(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.inbox.getMessage(user!.id, workspaceId, messageId),
    };
  }

  @Patch("workspaces/:workspaceId/messages/:messageId")
  @ApiOperation({
    summary: "Patch message flags — isRead, labels (emails:write)",
  })
  async update(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @Body(new ZodValidationPipe(messageUpdateBodySchema)) body: MessageUpdateBody,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.inbox.updateMessage(user!.id, workspaceId, messageId, body),
    };
  }
}
