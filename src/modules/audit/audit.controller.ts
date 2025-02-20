import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { uuidParamSchema } from "@/lib/http/params";
import { buildPagination, paginationQuerySchema } from "@/lib/http/pagination";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { PermissionKeys } from "@/lib/db/schema";
import { CurrentUser } from "@/modules/auth/decorators/auth.decorators";
import { AuditService } from "@/modules/audit/audit.service";
import { RbacService } from "@/modules/rbac/rbac.service";

const auditListQuerySchema = paginationQuerySchema.extend({
  // Prefix match on the dotted action namespace, e.g. "member." or "role.".
  action: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_.:-]+$/, "Invalid action filter")
    .optional(),
});

@ApiTags("audit")
@Controller()
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  @Get("workspaces/:workspaceId/audit-logs")
  @ApiOperation({ summary: "List a workspace's audit trail (audit_logs:read)" })
  async listForWorkspace(
    @Param("workspaceId", new ZodValidationPipe(uuidParamSchema)) workspaceId: string,
    @Query(new ZodValidationPipe(auditListQuerySchema))
    query: { page?: number; limit?: number; action?: string },
    @CurrentUser() user?: { id: string },
  ) {
    await this.rbac.requirePermission(
      user!.id,
      workspaceId,
      PermissionKeys.AuditLogsRead,
    );
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const { items, total } = await this.audit.listForWorkspace(workspaceId, {
      limit,
      offset: (page - 1) * limit,
      action: query.action,
    });
    return { data: items, pagination: buildPagination(page, limit, total) };
  }

  @Get("audit-logs")
  @ApiOperation({
    summary: "List the caller's own actions across their workspaces",
  })
  async listOwn(@Query(new ZodValidationPipe(paginationQuerySchema)) query: {
    page?: number;
    limit?: number;
  }, @CurrentUser() user?: { id: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const { items, total } = await this.audit.listForActor(user!.id, {
      limit,
      offset: (page - 1) * limit,
    });
    return { data: items, pagination: buildPagination(page, limit, total) };
  }
}
