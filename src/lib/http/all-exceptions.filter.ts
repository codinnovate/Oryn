import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { ErrorCode } from "@/lib/http/error-codes";
import { ApiError } from "@/lib/http/api-error";
import { getLogger } from "@/lib/logger";

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details: unknown;
    requestId: string;
  };
}

/**
 * Renders every error (framework, domain, unknown) into the standard envelope:
 * { error: { code, message, details, requestId } }.
 *
 * Unknown errors never leak internals to clients — messages are replaced with a
 * generic string in production while the full detail goes to structured logs.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = getLogger();

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, code, message, details } = this.normalize(exception);
    const requestId = getRequestId(request);

    if (status >= 500) {
      this.logger.error(
        {
          err: exception instanceof Error ? { name: exception.name, stack: exception.stack } : exception,
          requestId,
          method: request.method,
          url: request.originalUrl ?? request.url,
        },
        `Unhandled exception on ${request.method} ${request.url}`,
      );
    }

    const body: ErrorResponseBody = {
      error: {
        code,
        message,
        details: details ?? null,
        requestId,
      },
    };
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ErrorCode.VALIDATION_ERROR,
        message: "Request validation failed",
        details: flattenZodIssues(exception),
      };
    }

    if (exception instanceof ApiError) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === "string"
          ? payload
          : ((payload as Record<string, unknown>).message as string | undefined) ??
            exception.message;
      return {
        status,
        code: httpStatusToCode(status),
        message: Array.isArray(message) ? message.join("; ") : message,
        details: Array.isArray(message) ? message : undefined,
      };
    }

    // Unknown error: safe message only; internals stay in logs.
    const isProd = safeIsProd();
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: isProd
        ? "An unexpected error occurred"
        : exception instanceof Error
          ? exception.message
          : "An unexpected error occurred",
    };
  }
}

function flattenZodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.RESOURCE_NOT_FOUND;
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_ERROR;
    case HttpStatus.CONFLICT:
      return ErrorCode.RESOURCE_CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ErrorCode.PROVIDER_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : "REQUEST_FAILED";
  }
}

function getRequestId(request: Request): string {
  const existing = request.headers["x-request-id"];
  if (typeof existing === "string" && existing.length > 0 && existing.length <= 128) {
    return existing;
  }
  return (request as Request & { id?: string }).id ?? generateRequestId();
}

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function safeIsProd(): boolean {
  try {
    // Lazy import avoided intentionally: env may be invalid during boot errors.
    return process.env["NODE_ENV"] === "production";
  } catch {
    return false;
  }
}
