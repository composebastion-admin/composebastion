import { readdir } from "node:fs/promises";
import path from "node:path";
import { validateMigrationFilenames } from "./migrationLint.js";

const migrationsDir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.resolve(process.cwd(), "../../infra/postgres");

const files = await readdir(migrationsDir);
const issues = validateMigrationFilenames(files);

if (issues.length > 0) {
  for (const issue of issues) {
    const prefix = issue.file ? `${issue.file}: ` : "";
    console.error(`${prefix}${issue.message}`);
  }
  process.exitCode = 1;
}
