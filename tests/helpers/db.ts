import { getDb, closeDatabase } from "@/lib/db/database";
import { getTableName, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";

let cached: NodePgDatabase<typeof schema> | null = null;

export function getTestDb(): NodePgDatabase<typeof schema> {
  if (!cached) {
    cached = getDb();
  }
  return cached;
}

/** Deletes all rows from the given tables (fast reset between suites). */
export async function truncateTables(tables: PgTable[]): Promise<void> {
  const db = getTestDb();
  for (const table of tables) {
    await db.execute(
      sql.raw(`TRUNCATE TABLE "${getTableName(table)}" CASCADE`),
    );
  }
}

export async function closeTestDb(): Promise<void> {
  await closeDatabase();
  cached = null;
}

/** Expects `fn` to reject with a Postgres error carrying `code` (e.g. 23505). */
export async function expectPgCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected Postgres error with code ${code} but query succeeded`);
  } catch (err) {
    const pgCode =
      (err as { cause?: { code?: string } })?.cause?.code ??
      (err as { code?: string })?.code;
    if (pgCode !== code) {
      throw new Error(
        `Expected Postgres error ${code} but got ${pgCode ?? "non-PG error"}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
