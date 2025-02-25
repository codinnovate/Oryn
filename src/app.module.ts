import type { NestModule, MiddlewareConsumer } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "@/modules/health/health.module";
import { AuthModule } from "@/modules/auth/auth.module";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { AuditModule } from "@/modules/audit/audit.module";
import { EmailAccountsModule } from "@/modules/email-accounts/email-accounts.module";
import { SyncModule } from "@/modules/sync/sync.module";
import { InboxModule } from "@/modules/inbox/inbox.module";
import { MessagingModule } from "@/modules/messaging/messaging.module";
import { AccessLogInterceptor } from "@/lib/http/access-log.interceptor";
import { AllExceptionsFilter } from "@/lib/http/all-exceptions.filter";
import { RequestIdMiddleware } from "@/lib/http/request-id.middleware";
import { RedisModule } from "@/lib/redis/redis.module";
import { QueueModule } from "@/lib/queue/queue.module";
import { SessionGuard } from "@/modules/auth/guards/session.guard";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RedisModule, QueueModule, HealthModule, AuthModule, UsersModule, WorkspacesModule, AuditModule, EmailAccountsModule, SyncModule, InboxModule, MessagingModule],
  controllers: [],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
    // Secure by default: every route requires a session unless @Public().
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("{*path}");
  }
}
