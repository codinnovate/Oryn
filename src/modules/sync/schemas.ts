import { z } from "zod";

/** Payload enqueued onto the `email-sync` queue. */
export const syncJobDataSchema = z.object({
  workspaceId: z.uuid(),
  emailAccountId: z.uuid(),
});

export type SyncJobData = z.infer<typeof syncJobDataSchema>;
