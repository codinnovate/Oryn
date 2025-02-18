import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { paginationQuerySchema } from "@/lib/http/pagination";
import { uuidParamSchema } from "@/lib/http/params";
import { buildPagination } from "@/lib/http/pagination";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import {
  createWorkspaceSchema,
  inviteMemberSchema,
  updateMemberSchema,
  updateWorkspaceSchema,
  type CreateWorkspaceDto,
  type InviteMemberDto,
  type UpdateMemberDto,
  type UpdateWorkspaceDto,
} from "@/modules/workspaces/schemas";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";

@ApiTags("workspaces")
@Controller("workspaces")
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  @ApiOperation({ summary: "Create a workspace; caller becomes owner" })
  async create(
    @Body(new ZodValidationPipe(createWorkspaceSchema)) dto: CreateWorkspaceDto,
    @CurrentUser() user?: { id: string },
  ) {
    const workspace = await this.workspaces.create(user!.id, dto);
    return { data: workspace };
  }

  @Get()
  @ApiOperation({ summary: "List workspaces the caller belongs to" })
  async list(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: { page?: number; limit?: number },
    @CurrentUser() user?: { id: string },
  ) {
    const { page, limit } = buildPagination(query.page ?? 1, query.limit ?? 25, 0);
    const offset = (page - 1) * limit;
    const { items, total } = await this.workspaces.listForUser(user!.id, limit, offset);
    return {
      data: items,
      pagination: buildPagination(page, limit, total),
    };
  }

  @Get(":workspaceId")
  @ApiOperation({ summary: "Get a workspace (members only)" })
  async get(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @CurrentUser() user?: { id: string },
  ) {
    const workspace = await this.workspaces.getForUser(user!.id, workspaceId);
    return { data: workspace };
  }

  @Patch(":workspaceId")
  @ApiOperation({ summary: "Rename or update settings (owner only)" })
  async update(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Body(new ZodValidationPipe(updateWorkspaceSchema)) dto: UpdateWorkspaceDto,
    @CurrentUser() user?: { id: string },
  ) {
    const workspace = await this.workspaces.update(user!.id, workspaceId, dto);
    return { data: workspace };
  }

  @Delete(":workspaceId")
  @ApiOperation({ summary: "Soft-delete a workspace (owner only)" })
  async remove(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.workspaces.delete(user!.id, workspaceId);
    return { data: { deleted: true } };
  }

  @Get(":workspaceId/members")
  @ApiOperation({ summary: "List members with their role keys" })
  async members(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @CurrentUser() user?: { id: string },
  ) {
    const members = await this.workspaces.listMembers(user!.id, workspaceId);
    return {
      data: members.map((m) => ({
        id: m.member.id,
        userId: m.member.userId,
        email: m.email,
        name: m.name,
        status: m.member.status,
        joinedAt: m.member.joinedAt?.toISOString() ?? null,
        roleKeys: m.roleKeys,
      })),
    };
  }

  @Patch(":workspaceId/members/:memberId")
  @ApiOperation({ summary: "Update member status/role (members:manage)" })
  async updateMember(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("memberId", new ZodValidationPipe(uuidParamSchema)) memberId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) dto: UpdateMemberDto,
    @CurrentUser() user?: { id: string },
  ) {
    await this.workspaces.updateMember(user!.id, workspaceId, memberId, dto);
    return { data: { updated: true } };
  }

  @Delete(":workspaceId/members/:memberId")
  @ApiOperation({
    summary: "Remove a member; non-admins may only remove themselves",
  })
  async removeMember(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("memberId", new ZodValidationPipe(uuidParamSchema)) memberId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.workspaces.removeMember(user!.id, workspaceId, memberId);
    return { data: { removed: true } };
  }

  @Post(":workspaceId/invitations")
  @ApiOperation({ summary: "Invite an email to the workspace (members:invite)" })
  async invite(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Body(new ZodValidationPipe(inviteMemberSchema)) dto: InviteMemberDto,
    @CurrentUser() user?: { id: string },
  ) {
    const { invitation } = await this.workspaces.invite(user!.id, workspaceId, dto);
    return {
      data: {
        id: invitation.id,
        emailNormalized: invitation.emailNormalized,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
      },
    };
  }
}
