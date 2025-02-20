import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { AuditModule } from "@/modules/audit/audit.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { RolesService } from "@/modules/workspaces/roles.service";
import { RolesController } from "@/modules/workspaces/roles.controller";
import { WorkspacesController } from "@/modules/workspaces/workspaces.controller";
import { InvitationsController } from "@/modules/workspaces/invitations.controller";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";

@Module({
  imports: [AuthModule, AuditModule, RbacModule],
  controllers: [WorkspacesController, InvitationsController, RolesController],
  providers: [WorkspacesService, RolesService],
})
export class WorkspacesModule {}
