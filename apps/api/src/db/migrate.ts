import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { query, withTransaction } from "./pool.js";

// Arbitrary fixed key shared by every replica's migration runner.
const MIGRATION_LOCK_KEY = 776643;

async function findMigrationsDir() {
  const candidates = [
    env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "infra/postgres"),
    path.resolve(process.cwd(), "../../infra/postgres")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Could not find migrations directory. Checked: ${candidates.join(", ")}`);
}

export async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = await findMigrationsDir();
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    await withTransaction(async (client) => {
      // Serialize across concurrently starting API/worker replicas so a non-idempotent
      // migration is only ever applied once. The lock is released when the txn ends.
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (alreadyApplied.rowCount) return;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    });
  }
}
