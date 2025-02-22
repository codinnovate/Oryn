import { Queue } from "bullmq";
import Redis from "ioredis";
import { getEnv } from "@/lib/env";
import { getLogger } from "@/lib/logger";

/** Canonical queue names — keep in sync with docs/API.md "Planned modules". */
export const QUEUE_NAMES = {
  /** Incremental provider mailbox syncs triggered by API or schedules. */
  emailSync: "email-sync",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 3_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const queues = new Map<QueueName, Queue>();
const connections = new Set<Redis>();

/**
 * Dedicated connection factory for BullMQ. Queues and workers must not share
 * the application's general-purpose Redis client (`src/lib/redis`), because
 * BullMQ relies on blocking commands.
 */
function createConnection(): Redis {
  const env = getEnv();
  const connection = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  connection.on("error", (err) => {
    getLogger().warn({ err: err.message }, "redis queue connection error");
  });
  connections.add(connection);
  return connection;
}

/**
 * Returns the process-wide singleton queue for `name`, creating it lazily on
 * first use so nothing touches Redis until a job is actually enqueued.
 */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: createConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/**
 * Convenience wrapper: enqueues a named job onto a registered queue and
 * returns the BullMQ job id (exposed to clients as the async op identifier).
 */
export async function enqueue(
  name: QueueName,
  jobName: string,
  data: unknown,
  opts?: Parameters<Queue["add"]>[2],
): Promise<string> {
  const job = await getQueue(name).add(jobName, data, opts);
  return job.id ?? "";
}

/** Closes all queues and their connections; used on shutdown and in tests. */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  await Promise.allSettled(
    [...connections].map((c) => c.quit().catch(() => c.disconnect())),
  );
  connections.clear();
}


