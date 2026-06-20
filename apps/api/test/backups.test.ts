import path from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { safeBackupPath } from "../src/services/backups.js";

describe("backup paths", () => {
  it("keeps backup files under BACKUP_DIR", () => {
    const backupPath = safeBackupPath("volume.tar.gz");
    expect(backupPath).toBe(path.resolve(env.BACKUP_DIR, "volume.tar.gz"));
  });

  it("rejects path traversal", () => {
    expect(() => safeBackupPath("../outside.tar.gz")).toThrow("escapes backup directory");
  });
});
