import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "@/app.module";
import { getEnv } from "@/lib/env";
import { PinoLoggerService } from "@/lib/logger";
import { SyncService } from "@/modules/sync/sync.service";
import { startEmailSyncWorker } from "@/jobs/email-sync.processor";

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Route framework logs through pino.
    logger: new PinoLoggerService(),
  });

  app.setGlobalPrefix("api/v1", { exclude: [] });
  app.enableShutdownHooks();
  app.set("trust proxy", true);

  if (process.env["ENABLE_API_DOCS"] === "true" || env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("Oryn API")
      .setDescription("Intelligent email automation platform API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  const port = Number(process.env["PORT"] ?? 3000);
  await app.listen(port, "0.0.0.0");

  // Start background workers unless disabled (tests, or dedicated worker process).
  if (!env.DISABLE_SYNC_WORKER) {
    const syncService = app.get(SyncService);
    const worker = startEmailSyncWorker((id) => syncService.runAccountSync(id));
    const closeWorker = () => worker.close().catch(() => undefined);
    process.on("SIGTERM", closeWorker);
    process.on("SIGINT", closeWorker);
  }
}

bootstrap().catch((err) => {
  // Bootstrap failures must surface before the logger may be configured.
  process.stderr.write(`Fatal bootstrap error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
