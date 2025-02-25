import { Worker } from "bullmq";
import Redis from "ioredis";
import { QUEUE_NAMES } from "@/lib/queue/queues";
import { getEnv } from "@/lib/env";
import { getLogger } from "@/lib/logger";
import type { MessagingService } from "@/modules/messaging/messaging.service";

interface SendEmailJobData {
  scheduledEmailId: string;
}

/**
 * Boots an inline BullMQ worker for the `email-send` queue. Supports both
 * immediate and delayed (scheduled) sends — BullMQ handles the delay natively
 * so the processor only needs to execute the send when the job fires.
 */
export function startEmailSendWorker(
  runSend: MessagingService["runSend"],
): Worker {
  const logger = getLogger().child({ queue: QUEUE_NAMES.emailSend });

  const worker = new Worker(
    QUEUE_NAMES.emailSend,
    async (job) => {
      const data = job.data as SendEmailJobData;
      logger.info({ scheduledEmailId: data.scheduledEmailId }, "send job started");
      try {
        const result = await runSend(data.scheduledEmailId);
        logger.info(
          { scheduledEmailId: data.scheduledEmailId, providerMessageId: result.providerMessageId },
          "send job completed",
        );
        return result;
      } catch (err) {
        // If the email was already marked failed by the service, don't retry.
        if (job.attemptsMade >= (job.opts.attempts ?? 3) - 1) {
          logger.error(
            { scheduledEmailId: data.scheduledEmailId, err: err instanceof Error ? err.message : String(err) },
            "send job exhausted retries",
          );
          return { failed: true };
        }
        throw err;
      }
    },
    {
      connection: createConnection(),
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "send job failed");
  });

  return worker;
}

function createConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
}
