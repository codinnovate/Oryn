/**
 * Global Vitest setup: deterministic environment for all tests.
 * Runs before any test module imports application code.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://oryn:oryn@127.0.0.1:54329/oryn_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15";
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? "b29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb28="; // base64 of 32 bytes, test-only
process.env.STATE_SECRET = process.env.STATE_SECRET ?? "test-state-secret-do-not-use";
process.env.APP_URL = process.env.APP_URL ?? "http://localhost:3000";
