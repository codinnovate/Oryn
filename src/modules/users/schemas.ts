import { z } from "zod";

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    avatarUrl: z.url().max(2048).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(200)
    .regex(/[a-zA-Z]/, "Password must contain a letter")
    .regex(/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, "Password must contain a number or symbol"),
});

// Preferences are intentionally shallow-typed; unknown keys are rejected to
// keep the JSONB shape predictable.
export const preferencesSchema = z
  .object({
    timezone: z.string().max(64).optional(),
    locale: z.string().max(16).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    defaultAccountId: z.string().uuid().optional(),
  })
  .strict();

export const notificationPrefsSchema = z
  .object({
    emailDigest: z.boolean().optional(),
    importantEmails: z.boolean().optional(),
    automationResults: z.boolean().optional(),
    weeklyReport: z.boolean().optional(),
  })
  .strict();

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
export type PreferencesDto = z.infer<typeof preferencesSchema>;
export type NotificationPrefsDto = z.infer<typeof notificationPrefsSchema>;
