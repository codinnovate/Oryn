import { Pool, type PoolClient } from "pg";
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { getEnv } from "@/lib/env";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const env = getEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // A pooled client erroring asynchronously must not crash the process.
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("Unexpected Postgres pool error", err.message);
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  return drizzle(getPool(), { schema });
}

/** Runs `fn` inside a transaction; rolls back on throw. */
export async function withTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return getDb().transaction(fn);
}

export type DbTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Liveness probe for health checks. */
export async function pingDatabase(): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT 1");
    return true;
  } finally {
    client.release();
  }
}

/** Closes the pool; used on shutdown and in tests. */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type DbClient = NodePgDatabase<typeof schema> | PoolClient;
export { schema };
