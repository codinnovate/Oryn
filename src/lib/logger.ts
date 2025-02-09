import pino from "pino";
import { getEnv } from "@/lib/env";

let logger: pino.Logger | null = null;

/**
 * Redaction paths prevent accidental leakage of credentials into logs.
 * Anything logged under these keys is replaced with "[Redacted]".
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "clientSecret",
  "*.clientSecret",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
];

function createLogger(): pino.Logger {
  let level: pino.Level = "info";
  try {
    level = getEnv().LOG_LEVEL;
  } catch {
    // env not yet validated (e.g. during boot); fall back to default.
  }
  return pino({
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
    },
    base: { service: "oryn" },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = createLogger();
  }
  return logger;
}

/** NestJS LoggerService adapter so framework logs flow through pino. */
import type { LoggerService } from "@nestjs/common";

export class PinoLoggerService implements LoggerService {
  private readonly pino = getLogger();

  log(message: unknown, context?: string) {
    this.pino.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string) {
    this.pino.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string) {
    this.pino.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string) {
    this.pino.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string) {
    this.pino.trace({ context }, String(message));
  }
}
