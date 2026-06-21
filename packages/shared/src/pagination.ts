import { z } from "zod";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedResponse<T>(items: T[], total: number, query: PaginationQuery) {
  return {
    items,
    total,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + items.length < total
  };
}
