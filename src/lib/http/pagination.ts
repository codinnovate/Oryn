import { z } from "zod";

/** Standard pagination query parameters shared by all collection endpoints. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function buildPagination(
  page: number,
  limit: number,
  total: number,
): PageMeta {
  return {
    page,
    limit,
    total,
    hasNextPage: page * limit < total,
    hasPreviousPage: page > 1,
  };
}

export function buildCursorPagination(options: {
  nextCursor: string | null;
}): { nextCursor: string | null; hasNextPage: boolean } {
  return {
    nextCursor: options.nextCursor,
    hasNextPage: options.nextCursor !== null,
  };
}
