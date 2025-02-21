import { Module } from "@nestjs/common";
import { AuditModule } from "@/modules/audit/audit.module";
import { RbacModule } from "@/modules/rbac/rbac.module";
import { EmailAccountsController } from "@/modules/email-accounts/email-accounts.controller";
import { EmailAccountsService } from "@/modules/email-accounts/email-accounts.service";
import {
  createDefaultAdapters,
  EMAIL_PROVIDER_ADAPTERS,
} from "@/providers/provider.factory";

@Module({
  imports: [AuditModule, RbacModule],
  controllers: [EmailAccountsController],
  providers: [
    EmailAccountsService,
    {
      provide: EMAIL_PROVIDER_ADAPTERS,
      useFactory: createDefaultAdapters,
    },
  ],
  exports: [EmailAccountsService, EMAIL_PROVIDER_ADAPTERS],
})
export class EmailAccountsModule {}
