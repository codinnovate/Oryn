import type { NestModule, MiddlewareConsumer } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "@/modules/health/health.module";
import { AuthModule } from "@/modules/auth/auth.module";
import { UsersModule } from "@/modules/users/users.module";
import { AccessLogInterceptor } from "@/lib/http/access-log.interceptor";
import { AllExceptionsFilter } from "@/lib/http/all-exceptions.filter";
import { RequestIdMiddleware } from "@/lib/http/request-id.middleware";
import { SessionGuard } from "@/modules/auth/guards/session.guard";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule, AuthModule, UsersModule],
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
