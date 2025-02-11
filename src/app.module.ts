import type { NestModule, MiddlewareConsumer } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { HealthModule } from "@/modules/health/health.module";
import { AccessLogInterceptor } from "@/lib/http/access-log.interceptor";
import { AllExceptionsFilter } from "@/lib/http/all-exceptions.filter";
import { RequestIdMiddleware } from "@/lib/http/request-id.middleware";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule],
  controllers: [],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("{*path}");
  }
}
