import { Global, Module } from "@nestjs/common";
import { RedisService } from "@/lib/redis/redis.service";

/**
 * Global access to the shared Redis connection. The connection is lazy —
 * nothing dials Redis until the first command (see src/lib/redis/redis.ts).
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
