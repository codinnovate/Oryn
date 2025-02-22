import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { closeRedis, getRedis, pingRedis } from "@/lib/redis/redis";

/**
 * Injectable facade over the shared Redis connection (caches, rate limiting,
 * pub/sub). BullMQ uses its own dedicated connections and must not receive
 * this client.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  client() {
    return getRedis();
  }

  ping(): Promise<boolean> {
    return pingRedis();
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis();
  }
}
