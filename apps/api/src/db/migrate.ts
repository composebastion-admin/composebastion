import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { env } from "../config/env.js";
import { pool } from "./pool.js";

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

export async function runMigrations(connectionPool: Pick<Pool, "connect"> = pool) {
  const migrationsDir = await findMigrationsDir();
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await connectionPool.connect();
  let lockAcquired = false;
  let clientMustBeDestroyed = false;
  let runFailed = false;
  let runError: unknown;

  try {
    // The ledger itself is shared bootstrap state, so take a session lock before its
    // DDL and keep this exact connection checked out until every migration finishes.
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      await client.query("BEGIN");
      try {
        const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
        if (!alreadyApplied.rowCount) {
          const sql = await readFile(path.join(migrationsDir, file), "utf8");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        }

        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          clientMustBeDestroyed = true;
          throw new AggregateError([error, rollbackError], `Migration ${file} failed and rollback also failed`);
        }
        throw error;
      }
    }
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  let unlockError: unknown;
  let unlockFailed = false;
  if (lockAcquired) {
    try {
      const result = await client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
        [MIGRATION_LOCK_KEY]
      );
      if (result.rows[0]?.unlocked !== true) {
        throw new Error("PostgreSQL migration advisory lock was not held during release");
      }
    } catch (error) {
      unlockFailed = true;
      unlockError = error;
    }
  }

  if (unlockFailed) {
    client.release(unlockError instanceof Error ? unlockError : true);
    if (runFailed) {
      throw new AggregateError([runError, unlockError], "Migration failed and its advisory lock could not be released");
    }
    throw unlockError;
  }

  if (runFailed && !lockAcquired) {
    client.release(runError instanceof Error ? runError : true);
    throw runError;
  }

  if (clientMustBeDestroyed) {
    client.release(true);
  } else {
    client.release();
  }
  if (runFailed) {
    throw runError;
  }
}
