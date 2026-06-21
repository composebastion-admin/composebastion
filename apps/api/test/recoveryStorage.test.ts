import path from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { hashFile, recoveryPointDir, recoveryPointsRootDir, safeRecoveryPointFile } from "../src/services/recoveryStorage.js";

describe("recovery storage paths", () => {
  it("keeps recovery files under BACKUP_DIR/recovery-points/<id>", () => {
    const pointId = "00000000-0000-4000-8000-000000000001";
    const storagePath = safeRecoveryPointFile(pointId, "volumes/data.tar.gz");
    expect(storagePath).toBe(path.resolve(recoveryPointDir(pointId), "volumes/data.tar.gz"));
    expect(storagePath.startsWith(path.resolve(env.BACKUP_DIR, "recovery-points"))).toBe(true);
    expect(recoveryPointsRootDir()).toBe(path.resolve(env.BACKUP_DIR, "recovery-points"));
  });

  it("rejects path traversal", () => {
    expect(() => safeRecoveryPointFile("point-id", "../outside.tar.gz")).toThrow("escapes recovery point directory");
  });

  it("refuses to hash files outside BACKUP_DIR", async () => {
    await expect(hashFile(path.resolve("/tmp/outside-composebastion-backups.txt"))).rejects.toThrow("outside backup directory");
  });
});
