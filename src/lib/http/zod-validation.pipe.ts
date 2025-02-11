import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { ZodType } from "zod";
import { ApiError } from "@/lib/http/api-error";

export interface ZodValidationOptions {
  /** Human-readable name used in validation error messages. */
  name?: string;
}

/**
 * Validates and parses a value with a Zod schema, converting failures into
 * the standard VALIDATION_ERROR envelope.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly options: ZodValidationOptions = {},
  ) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw ApiError.validation(
        `${this.options.name ?? "Request"} validation failed`,
        result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
