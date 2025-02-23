import { z } from "zod";

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes"].includes(v.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379/0"),

  ENCRYPTION_KEY: z.string().min(1),
  STATE_SECRET: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default("common"),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),

  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  EMAIL_BODY_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),

  DISABLE_WEBHOOK_SIGNATURE_CHECKS: boolish.default(false),
  DISABLE_SYNC_WORKER: boolish.default(false),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration -> ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only escape hatch to reset the cached env after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
