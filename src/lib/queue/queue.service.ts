import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  closeQueues,
  enqueue as enqueueRaw,
  getQueue,
  QUEUE_NAMES,
  type QueueName,
} from "@/lib/queue/queues";

/**
 * Thin injectable facade over the queue registry so feature modules can
 * enqueue jobs without reaching for singletons. Job payloads are validated
 * by the calling module's Zod schemas before they reach this layer.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  get names(): typeof QUEUE_NAMES {
    return QUEUE_NAMES;
  }

  queue(name: QueueName): Queue {
    return getQueue(name);
  }

  async enqueue<JobData>(
    name: QueueName,
    jobName: string,
    data: JobData,
    opts?: Parameters<Queue["add"]>[2],
  ): Promise<string> {
    return enqueueRaw(name, jobName, data, opts);
  }

  async onApplicationShutdown(): Promise<void> {
    await closeQueues();
  }
}
