import { z } from "zod";

/** Shared password policy: length + basic complexity, no max truncation surprises. */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200)
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/, "Password must contain a number or symbol");

export const emailSchema = z.email().max(320);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
