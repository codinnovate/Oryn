import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { buildCursorPagination, buildPagination, paginationQuerySchema } from "@/lib/http/pagination";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { ApiError } from "@/lib/http/api-error";

describe("pagination", () => {
  it("applies defaults and coerces strings", () => {
    const parsed = paginationQuerySchema.parse({ page: "3", limit: "10" });
    expect(parsed).toEqual({ page: 3, limit: 10 });
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
  });

  it("rejects out-of-range values", () => {
    expect(() => paginationQuerySchema.parse({ page: 0 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 1000 })).toThrow();
  });

  it("computes page metadata", () => {
    expect(buildPagination(1, 50, 230)).toEqual({
      page: 1,
      limit: 50,
      total: 230,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(buildPagination(5, 50, 230).hasNextPage).toBe(false);
    expect(buildPagination(2, 50, 230).hasPreviousPage).toBe(true);
    expect(buildPagination(1, 10, 0)).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it("computes cursor metadata", () => {
    expect(buildCursorPagination({ nextCursor: "abc" })).toEqual({
      nextCursor: "abc",
      hasNextPage: true,
    });
    expect(buildCursorPagination({ nextCursor: null }).hasNextPage).toBe(false);
  });
});

describe("ZodValidationPipe", () => {
  const schema = z.object({
    email: z.email(),
    age: z.number().int().min(18),
  });
  type Payload = z.infer<typeof schema>;
  let pipe: ZodValidationPipe<Payload>;

  beforeEach(() => {
    pipe = new ZodValidationPipe(schema);
  });

  it("returns parsed data on success", () => {
    const value = pipe.transform(
      { email: "a@b.co", age: 21 },
      { type: "body", metatype: Object },
    );
    expect(value).toEqual({ email: "a@b.co", age: 21 });
  });

  it("rejects string-typed numbers (strict parsing)", () => {
    expect(() =>
      pipe.transform({ email: "a@b.co", age: "21" }, { type: "body", metatype: Object }),
    ).toThrow(ApiError);
  });

  it("throws VALIDATION_ERROR with flattened details on failure", () => {
    try {
      pipe.transform({ email: "nope", age: 5 }, { type: "body", metatype: Object });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("VALIDATION_ERROR");
      const details = apiErr.details as Array<{ path: string; message: string }>;
      expect(details.some((d) => d.path === "email")).toBe(true);
      expect(details.some((d) => d.path === "age")).toBe(true);
    }
  });

  it("uses the provided name in the error message", () => {
    const named = new ZodValidationPipe(schema, { name: "Signup payload" });
    try {
      named.transform({}, { type: "body", metatype: Object });
    } catch (err) {
      expect((err as ApiError).message).toContain("Signup payload");
    }
  });
});
