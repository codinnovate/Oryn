import Redis from "ioredis";
import { getEnv } from "@/lib/env";
import { getLogger } from "@/lib/logger";

let client: Redis | null = null;

/**
 * Shared Redis connection for caches, rate limiting and ad-hoc pub/sub.
 * BullMQ queues/workers create their own dedicated connections (see
 * `src/lib/queue`); do not hand the shared client to BullMQ.
 *
 * The connection is lazy: nothing dials Redis until the first command, so
 * importing this module never blocks boot or tests.
 */
export function getRedis(): Redis {
  if (!client) {
    const env = getEnv();
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    // An idle connection error must not crash the process.
    client.on("error", (err) => {
      getLogger().warn({ err: err.message }, "redis connection error");
    });
  }
  return client;
}

/** Round-trip probe for readiness checks; safe to call repeatedly. */
export async function pingRedis(): Promise<boolean> {
  try {
    const reply = await getRedis().ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}

/** Closes the shared connection; used on shutdown and in tests. */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
