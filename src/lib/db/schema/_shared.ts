import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Shared column builders so every table gets consistent PK/timestamps.
 * All timestamps are timezone-aware.
 */
export const primaryId = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
