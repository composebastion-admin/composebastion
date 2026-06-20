import { describe, expect, it } from "vitest";
import { validateMigrationFilenames } from "../src/db/migrationLint.js";

const currentMigrations = [
  "001_init.sql",
  "002_operations_wave.sql",
  "003_ssh_password_auth.sql",
  "004_operator_p1.sql",
  "005_admin_usernames.sql",
  "006_platform_improvements.sql",
  "007_backup_schedules.sql",
  "008_stack_platform.sql",
  "009_app_inventory.sql",
  "010_app_source_links.sql",
  "011_stack_health.sql",
  "012_recovery_center.sql",
  "013_recovery_schedule_capture_mode.sql",
  "014_login_attempt_ip_address.sql",
  "015_backup_system.sql",
  "016_backup_encryption.sql",
  "017_backup_drills_and_key_fingerprint.sql",
  "018_backup_security_residuals.sql",
  "018_host_metric_alerts.sql",
  "019_session_metadata.sql"
];

describe("validateMigrationFilenames", () => {
  it("allows the current published legacy duplicate only", () => {
    expect(validateMigrationFilenames(currentMigrations)).toEqual([]);
  });

  it("blocks new duplicate migration prefixes", () => {
    const issues = validateMigrationFilenames([...currentMigrations, "020_first.sql", "020_second.sql"]);
    expect(issues).toContainEqual(expect.objectContaining({
      message: "Migration prefix 020 is duplicated. Use the next unused number instead."
    }));
  });

  it("blocks gaps in migration numbering", () => {
    const issues = validateMigrationFilenames(["001_init.sql", "003_skip.sql"]);
    expect(issues).toContainEqual({ message: "Migration prefix 002 is missing." });
  });

  it("blocks non-standard names", () => {
    const issues = validateMigrationFilenames(["001_init.sql", "002-Not-Good.sql"]);
    expect(issues).toContainEqual({
      file: "002-Not-Good.sql",
      message: "Migration names must use NNN_snake_case.sql."
    });
  });

  it("accepts the next clean migration number after the legacy duplicate", () => {
    expect(validateMigrationFilenames([...currentMigrations, "020_next_polish.sql"])).toEqual([]);
  });
});
