import { Worker } from "bullmq";
import Redis from "ioredis";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { getEnv } from "@/lib/env";
import { getLogger } from "@/lib/logger";
import type { SyncService } from "@/modules/sync/sync.service";
import type { SyncJobData } from "@/modules/sync/schemas";

/**
 * Boots an inline BullMQ worker for the `email-sync` queue. The processor
 * delegates to SyncService.runAccountSync which performs the actual
 * provider fetch + DB upsert.
 *
 * Called once from main.ts after the NestJS app is initialized so that the
 * SyncService instance (and all its dependencies) are resolved via DI.
 */
export function startEmailSyncWorker(runSync: SyncService["runAccountSync"]): Worker {
  const logger = getLogger().child({ queue: QUEUE_NAMES.emailSync });

  const worker = new Worker(
    QUEUE_NAMES.emailSync,
    async (job) => {
      const data = job.data as SyncJobData;
      logger.info({ emailAccountId: data.emailAccountId }, "sync job started");
      try {
        const result = await runSync(data.emailAccountId);
        logger.info(
          {
            emailAccountId: data.emailAccountId,
            pages: result.pagesFetched,
            created: result.created,
            updated: result.updated,
          },
          "sync job completed",
        );
        return result;
      } catch (err) {
        // NonRetryableSyncError is terminal — do not let BullMQ retry.
        if (err instanceof Error && err.name === "NonRetryableSyncError") {
          logger.warn(
            { emailAccountId: data.emailAccountId, reason: err.message },
            "sync job failed (non-retryable)",
          );
          return { skipped: true };
        }
        // Everything else is transient — throw to trigger backoff retries.
        throw err;
      }
    },
    {
      connection: createConnection(),
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "sync job failed");
  });

  return worker;
}

function createConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
}
