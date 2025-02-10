import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { getDb, closeDatabase } from "@/lib/db/database";

/**
 * Applies pending Drizzle migrations to the configured database.
 * Safe to run repeatedly (migrations are journaled).
 */
export async function runMigrations(databaseUrl?: string): Promise<void> {
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }
  try {
    const db = getDb();
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await closeDatabase();
  }
}
