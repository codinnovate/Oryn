import { Module } from "@nestjs/common";
import { AuditController } from "@/modules/audit/audit.controller";
import { AuditService } from "@/modules/audit/audit.service";
import { RbacModule } from "@/modules/rbac/rbac.module";

@Module({
  imports: [RbacModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
