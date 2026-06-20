export type MigrationLintIssue = {
  file?: string;
  message: string;
};

const migrationNamePattern = /^(\d{3})_[a-z0-9_]+\.sql$/;
const legacyDuplicatePrefixes = new Map([
  ["018", new Set(["018_backup_security_residuals.sql", "018_host_metric_alerts.sql"])]
]);

export function validateMigrationFilenames(files: string[]): MigrationLintIssue[] {
  const issues: MigrationLintIssue[] = [];
  const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort();
  const byPrefix = new Map<string, string[]>();

  for (const file of sqlFiles) {
    const match = file.match(migrationNamePattern);
    if (!match) {
      issues.push({ file, message: "Migration names must use NNN_snake_case.sql." });
      continue;
    }
    const prefix = match[1]!;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }

  for (const [prefix, duplicates] of byPrefix.entries()) {
    if (duplicates.length <= 1) continue;
    const allowed = legacyDuplicatePrefixes.get(prefix);
    const isAllowedLegacyDuplicate = allowed
      && duplicates.length === allowed.size
      && duplicates.every((file) => allowed.has(file));
    if (!isAllowedLegacyDuplicate) {
      issues.push({
        file: duplicates.join(", "),
        message: `Migration prefix ${prefix} is duplicated. Use the next unused number instead.`
      });
    }
  }

  const numbers = [...byPrefix.keys()].map((prefix) => Number(prefix)).sort((a, b) => a - b);
  if (numbers.length > 0) {
    const unique = [...new Set(numbers)];
    for (let expected = unique[0]!, index = 0; expected <= unique[unique.length - 1]!; expected += 1, index += 1) {
      if (unique[index] !== expected) {
        issues.push({ message: `Migration prefix ${String(expected).padStart(3, "0")} is missing.` });
        index -= 1;
      }
    }
  }

  return issues;
}
