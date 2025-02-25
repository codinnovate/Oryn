import { Module } from "@nestjs/common";
import { EmailAccountsModule } from "@/modules/email-accounts/email-accounts.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { MessagingController } from "@/modules/messaging/messaging.controller";
import { MessagingService } from "@/modules/messaging/messaging.service";

@Module({
  imports: [EmailAccountsModule, RbacModule],
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
