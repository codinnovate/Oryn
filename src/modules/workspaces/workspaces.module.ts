import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { RbacService } from "@/modules/workspaces/rbac.service";
import { WorkspacesController } from "@/modules/workspaces/workspaces.controller";
import { InvitationsController } from "@/modules/workspaces/invitations.controller";
import { WorkspacesService } from "@/modules/workspaces/workspaces.service";

@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController, InvitationsController],
  providers: [RbacService, WorkspacesService],
  exports: [RbacService],
})
export class WorkspacesModule {}
