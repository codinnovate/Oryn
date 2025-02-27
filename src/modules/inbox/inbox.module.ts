import { Module } from "@nestjs/common";
import { EmailAccountsModule } from "@/modules/email-accounts/email-accounts.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { InboxController } from "@/modules/inbox/inbox.controller";
import { InboxService } from "@/modules/inbox/inbox.service";

@Module({
  imports: [RbacModule, EmailAccountsModule],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
