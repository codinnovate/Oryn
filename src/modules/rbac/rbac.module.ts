import { Module } from "@nestjs/common";
import { RbacService } from "@/modules/rbac/rbac.service";

/**
 * Shared authorization foundation. Imported by any module whose
 * controllers/services need membership or permission checks.
 */
@Module({
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
