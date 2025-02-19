import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { RbacService } from "@/modules/workspaces/rbac.service";
import { RolesService } from "@/modules/workspaces/roles.service";
import { RolesController } from "@/modules/workspaces/roles.controller";
import { WorkspacesController } from "@/modules/workspaces/workspaces.controller";
import { InvitationsController } from "@/modules/workspaces/invitations.controller";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";

@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController, InvitationsController, RolesController],
  providers: [RbacService, WorkspacesService, RolesService],
  exports: [RbacService],
})
export class WorkspacesModule {}
