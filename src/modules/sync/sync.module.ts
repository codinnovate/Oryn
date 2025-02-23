import { Module } from "@nestjs/common";
import { EmailAccountsModule } from "@/modules/email-accounts/email-accounts.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { SyncController } from "@/modules/sync/sync.controller";
import { SyncService } from "@/modules/sync/sync.service";

@Module({
  imports: [EmailAccountsModule, RbacModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
