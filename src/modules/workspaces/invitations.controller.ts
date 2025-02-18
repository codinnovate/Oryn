import { Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import {
  CurrentUser,
  Public,
} from "@/modules/auth/decorators/auth.decorators";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";

@ApiTags("invitations")
@Controller()
export class InvitationsController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Public()
  @Get("invitations/:token")
  @ApiOperation({ summary: "Preview an invitation (public, minimal fields)" })
  async preview(
    @Param("token") token: string,
  ) {
    const data = await this.workspaces.previewInvitation(token);
    return { data };
  }

  @HttpCode(200)
  @Post("invitations/:token/accept")
  @ApiOperation({
    summary: "Accept an invitation",
    description:
      "Requires authentication; the account email must match the invited address.",
  })
  async accept(
    @Param("token") token: string,
    @CurrentUser() user?: { id: string; email: string },
  ) {
    const member = await this.workspaces.acceptInvitation(
      user!.id,
      user!.email,
      token,
    );
    return {
      data: {
        workspaceId: member.workspaceId,
        memberId: member.id,
        status: member.status,
        joinedAt: member.joinedAt?.toISOString() ?? null,
      },
    };
  }

  @Delete("workspaces/:workspaceId/invitations/:invitationId")
  @ApiOperation({ summary: "Revoke a pending invitation (members:invite)" })
  async revoke(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("invitationId", new ZodValidationPipe(uuidParamSchema)) invitationId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.workspaces.revokeInvitation(user!.id, workspaceId, invitationId);
    return { data: { revoked: true } };
  }
}
