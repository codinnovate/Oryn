import { z } from "zod";

export const providerIdSchema = z.enum(["gmail", "outlook"]);
export type ProviderIdParam = z.infer<typeof providerIdSchema>;

export const oauthCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(2048).optional(),
    state: z.string().min(8).max(4096).optional(),
    error: z.string().max(128).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.error), {
    message: "Exactly one of code or error is required",
  })
  .refine((v) => typeof v.state === "string", { message: "state is required" });

export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
