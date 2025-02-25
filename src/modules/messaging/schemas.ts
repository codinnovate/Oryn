import { z } from "zod";

const emailAddress = z.string().email().max(254);
const emailAddresses = z.union([emailAddress, z.array(emailAddress).min(1).max(50)]).transform(
  (v) => (Array.isArray(v) ? v : [v]),
);

export const sendMessageBodySchema = z.object({
  to: emailAddresses,
  cc: emailAddresses.optional(),
  bcc: emailAddresses.optional(),
  subject: z.string().min(1).max(998),
  text: z.string().max(2_097_152).optional(),
  html: z.string().max(2_097_152).optional(),
}).refine((d) => d.text || d.html, {
  message: "At least one of text or html body is required",
});

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

export const scheduleEmailBodySchema = sendMessageBodySchema.extend({
  scheduledFor: z.coerce.date().refine((d) => d.getTime() > Date.now(), {
    message: "scheduledFor must be in the future",
  }),
});

export type ScheduleEmailBody = z.infer<typeof scheduleEmailBodySchema>;
