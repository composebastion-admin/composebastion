import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const { Pool } = pg;
const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("migration bootstrap concurrency", () => {
  let schema: string | undefined;
  let runnerPools: Array<InstanceType<typeof Pool>> = [];

  afterEach(async () => {
    await Promise.allSettled(runnerPools.map((runnerPool) => runnerPool.end()));
    runnerPools = [];
    if (schema) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      schema = undefined;
    }
  });

  it("serializes two fresh migration runners before creating the ledger", async () => {
    schema = `migration_bootstrap_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${schema}`);

    runnerPools = [
      new Pool({ connectionString: env.DATABASE_URL, options: `-c search_path=${schema}`, max: 1 }),
      new Pool({ connectionString: env.DATABASE_URL, options: `-c search_path=${schema}`, max: 1 })
    ];

    await Promise.all(runnerPools.map((runnerPool) => runMigrations(runnerPool)));

    const applied = await runnerPools[0]!.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version"
    );
    const expectedVersions = (await readdir(new URL("../../../../infra/postgres/", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(applied.rows.map((row) => row.version)).toEqual(expectedVersions);
    await expect(runnerPools[1]!.query("SELECT 1 FROM worker_instances LIMIT 1")).resolves.toBeDefined();
  });
});
