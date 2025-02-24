import { Module } from "@nestjs/common";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { InboxController } from "@/modules/inbox/inbox.controller";
import { InboxService } from "@/modules/inbox/inbox.service";

@Module({
  imports: [RbacModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
