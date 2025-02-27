import { Controller, Get, Param, Patch, Body, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
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
    summary: "Patch message flags — isRead, labels (emails:read)",
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

  @Get("workspaces/:workspaceId/messages/:messageId/body")
  @ApiOperation({ summary: "Fetch message body — lazily cached from provider (emails:read)" })
  async body(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.inbox.getMessageBody(user!.id, workspaceId, messageId),
    };
  }

  @Get("workspaces/:workspaceId/messages/:messageId/attachments")
  @ApiOperation({ summary: "List attachment metadata — lazily cached from provider (emails:read)" })
  async attachments(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @CurrentUser() user?: { id: string },
  ) {
    return {
      data: await this.inbox.listAttachments(user!.id, workspaceId, messageId),
    };
  }

  @Get("workspaces/:workspaceId/messages/:messageId/attachments/:attachmentId")
  @ApiOperation({ summary: "Download a single attachment (emails:read)" })
  async attachment(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("messageId", new ZodValidationPipe(uuidParamSchema)) messageId: string,
    @Param("attachmentId", new ZodValidationPipe(uuidParamSchema)) attachmentId: string,
    @CurrentUser() user?: { id: string },
    @Res() res?: Response,
  ) {
    const { buffer, filename, mimeType } = await this.inbox.getAttachment(
      user!.id,
      workspaceId,
      messageId,
      attachmentId,
    );
    res!.setHeader("Content-Type", mimeType);
    res!.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res!.setHeader("Content-Length", buffer.length);
    res!.send(buffer);
  }
}
