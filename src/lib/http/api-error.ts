import { HttpException } from "@nestjs/common";
import type { ErrorCodeValue } from "@/lib/http/error-codes";

interface ApiErrorOptions {
  status?: number;
  details?: unknown;
  cause?: unknown;
}

/**
 * Domain-level error carrying a stable machine-readable code.
 * Thrown by services; rendered into the standard error envelope by
 * AllExceptionsFilter.
 */
export class ApiError extends HttpException {
  readonly code: ErrorCodeValue;
  readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, options: ApiErrorOptions = {}) {
    super(message, options.status ?? mapDefaultStatus(code));
    this.code = code;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  static unauthorized(message = "Authentication required"): ApiError {
    return new ApiError("UNAUTHORIZED", message, { status: 401 });
  }

  static forbidden(message = "You do not have permission to perform this action"): ApiError {
    return new ApiError("FORBIDDEN", message, { status: 403 });
  }

  static notFound(message = "Resource not found"): ApiError {
    return new ApiError("RESOURCE_NOT_FOUND", message, { status: 404 });
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError("VALIDATION_ERROR", message, { status: 400, details });
  }

  static conflict(message: string, code: ErrorCodeValue = "RESOURCE_CONFLICT", details?: unknown): ApiError {
    return new ApiError(code, message, { status: 409, details });
  }
}

function mapDefaultStatus(code: ErrorCodeValue): number {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 400;
    case "RATE_LIMITED":
    case "PROVIDER_RATE_LIMITED":
      return 429;
    case "PROVIDER_UNAVAILABLE":
    case "AI_SERVICE_UNAVAILABLE":
      return 503;
    case "ATTACHMENT_TOO_LARGE":
      return 413;
    case "INVALID_ATTACHMENT":
      return 415;
    case "EMAIL_ACCOUNT_NOT_CONNECTED":
    case "OAUTH_TOKEN_EXPIRED":
    case "SYNC_FAILED":
    case "RULE_EXECUTION_FAILED":
      return 409;
    default:
      return 500;
  }
}
