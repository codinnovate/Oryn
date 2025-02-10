import { runMigrations } from "@/lib/db/migrate";

runMigrations()
  .then(() => {
    process.stdout.write("Migrations applied successfully\n");
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
