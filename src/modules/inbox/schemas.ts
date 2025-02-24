import { z } from "zod";
import { paginationQuerySchema } from "@/lib/http/pagination";

/**
 * Coerces "false"/"0"/"no" → false, "true"/"1"/"yes" → true.
 * Without this, `?isRead=false` would coerce to Boolean("false") = true.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes"].includes(v.toLowerCase())));

export const messageListQuerySchema = paginationQuerySchema.extend({
  emailAccountId: z.string().uuid().optional(),
  isRead: boolish.optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  /** Free-text search against subject and snippet (case-insensitive). */
  q: z.string().min(1).max(200).optional(),
  receivedAfter: z.coerce.date().optional(),
  receivedBefore: z.coerce.date().optional(),
  sort: z.enum(["receivedAt", "-receivedAt"]).default("-receivedAt"),
});

export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export const messageUpdateBodySchema = z
  .object({
    isRead: z.boolean().optional(),
    labels: z.array(z.string().max(100)).max(100).optional(),
  })
  .refine((d) => d.isRead !== undefined || d.labels !== undefined, {
    message: "At least one field (isRead, labels) must be provided",
  });

export type MessageUpdateBody = z.infer<typeof messageUpdateBodySchema>;
