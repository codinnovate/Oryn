import { describe, it, expect, beforeEach } from "vitest";
import { getEnv, resetEnvCache } from "@/lib/env";

const VALID_ENV: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379/0",
  ENCRYPTION_KEY: "x".repeat(44),
  STATE_SECRET: "s".repeat(32),
};

describe("getEnv", () => {
  beforeEach(() => {
    resetEnvCache();
    for (const key of Object.keys(process.env)) {
      if (!["NODE_ENV", "PATH", "HOME", "TMPDIR"].includes(key)) {
        delete process.env[key];
      }
    }
  });

  it("accepts a valid minimal configuration", () => {
    Object.assign(process.env, VALID_ENV);
    const env = getEnv();
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => getEnv()).toThrow(/Invalid environment configuration/);
  });

  it("throws when ENCRYPTION_KEY is missing", () => {
    const { ENCRYPTION_KEY: _drop, ...rest } = VALID_ENV;
    Object.assign(process.env, rest);
    expect(() => getEnv()).toThrow(/Invalid environment configuration/);
  });

  it("caches the parsed result", () => {
    Object.assign(process.env, VALID_ENV);
    expect(getEnv()).toBe(getEnv());
  });

  it("coerces numeric limits from strings", () => {
    Object.assign(process.env, { ...VALID_ENV, ATTACHMENT_MAX_BYTES: "1024" });
    expect(getEnv().ATTACHMENT_MAX_BYTES).toBe(1024);
  });
});
