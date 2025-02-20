import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { uuidParamSchema } from "@/lib/http/params";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { z } from "zod";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { PermissionKeys } from "@/lib/db/schema";
import { RbacService } from "@/modules/rbac/rbac.service";
import { RolesService } from "@/modules/workspaces/roles.service";

const roleKeyFormat = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, "Key must be lowercase letters/digits/dashes");

const createRoleSchema = z.object({
  key: roleKeyFormat.refine(
    (k) => !["owner", "admin", "member", "viewer"].includes(k),
    "Reserved system role key",
  ),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  permissionKeys: z.array(z.string()).max(32),
});

const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    permissionKeys: z.array(z.string()).max(32).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

@ApiTags("roles")
@Controller()
export class RolesController {
  constructor(
    private readonly rbac: RbacService,
    private readonly rolesService: RolesService,
  ) {}

  @Get("permissions")
  @ApiOperation({ summary: "List global permission keys (authenticated)" })
  async listPermissions() {
    const rows = await this.rolesService.listGlobalPermissions();
    return { data: rows };
  }

  @Get("workspaces/:workspaceId/roles")
  @ApiOperation({ summary: "List workspace roles with permission keys (members)" })
  async list(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.rbac.requireMembership(user!.id, workspaceId);
    return { data: await this.rolesService.list(workspaceId) };
  }

  @Post("workspaces/:workspaceId/roles")
  @ApiOperation({ summary: "Create a custom role (roles:manage)" })
  async create(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Body(new ZodValidationPipe(createRoleSchema))
    dto: {
      key: string;
      name: string;
      description?: string | null;
      permissionKeys: string[];
    },
    @CurrentUser() user?: { id: string },
  ) {
    await this.rbac.requirePermission(
      user!.id,
      workspaceId,
      PermissionKeys.RolesManage,
    );
    return { data: await this.rolesService.create(user!.id, workspaceId, dto) };
  }

  @Patch("workspaces/:workspaceId/roles/:roleId")
  @ApiOperation({ summary: "Update a role; system roles are immutable (roles:manage)" })
  async update(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("roleId", new ZodValidationPipe(uuidParamSchema)) roleId: string,
    @Body(new ZodValidationPipe(updateRoleSchema))
    dto: { name?: string; description?: string | null; permissionKeys?: string[] },
    @CurrentUser() user?: { id: string },
  ) {
    await this.rbac.requirePermission(
      user!.id,
      workspaceId,
      PermissionKeys.RolesManage,
    );
    return {
      data: await this.rolesService.update(user!.id, workspaceId, roleId, dto),
    };
  }

  @Delete("workspaces/:workspaceId/roles/:roleId")
  @ApiOperation({ summary: "Delete an unassigned custom role (roles:manage)" })
  async remove(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Param("roleId", new ZodValidationPipe(uuidParamSchema)) roleId: string,
    @CurrentUser() user?: { id: string },
  ) {
    await this.rbac.requirePermission(
      user!.id,
      workspaceId,
      PermissionKeys.RolesManage,
    );
    await this.rolesService.delete(user!.id, workspaceId, roleId);
    return { data: { deleted: true } };
  }
}
