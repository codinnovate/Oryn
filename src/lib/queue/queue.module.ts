import { Global, Module } from "@nestjs/common";
import { QueueService } from "@/lib/queue/queue.service";

/**
 * Global access to BullMQ queues. Connections stay lazy — nothing dials
 * Redis until a job is enqueued (see src/lib/queue/queues.ts).
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
