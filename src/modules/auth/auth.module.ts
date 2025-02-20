import { Module } from "@nestjs/common";
import { AuthController } from "@/modules/auth/auth.controller";
import { AuthService } from "@/modules/auth/auth.service";
import { SessionGuard } from "@/modules/auth/guards/session.guard";
import { SessionService } from "@/modules/auth/session.service";
import { AuditModule } from "@/modules/audit/audit.module";
import { ConsoleMailer } from "@/lib/mailer/mailer";
import { MAILER } from "@/lib/mailer/mailer.tokens";

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    SessionGuard,
    { provide: MAILER, useClass: ConsoleMailer },
  ],
  exports: [SessionService, AuthService, MAILER],
})
export class AuthModule {}
