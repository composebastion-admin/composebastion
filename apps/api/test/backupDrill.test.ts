import { describe, expect, it } from "vitest";
import {
  assertAllowedBackupDrillPath,
  BACKUP_DRILL_ROOT,
  buildBackupDrillPath,
  buildBackupDrillVolumeName,
  runBackupDrillWithTeardown
} from "../src/services/backups.js";

describe("backup restore drills", () => {
  it("builds safe scratch volume names and managed scratch paths", () => {
    const backupId = "00000000-0000-4000-8000-000000000001";
    const drillId = "11111111-1111-4111-8111-111111111111";

    const volume = buildBackupDrillVolumeName(backupId, drillId);
    expect(volume).toMatch(/^drill-[a-zA-Z0-9_.-]+$/);
    expect(volume).not.toContain("/");
    expect(volume.length).toBeLessThanOrEqual(80);

    const drillPath = buildBackupDrillPath(backupId, drillId);
    expect(drillPath).toBe(`${BACKUP_DRILL_ROOT}/000000000000/111111111111`);
    expect(assertAllowedBackupDrillPath(drillPath)).toBe(drillPath);
    expect(() => assertAllowedBackupDrillPath("/var/lib/dockermender/not-drills/escape")).toThrow();
  });

  it("runs teardown after failed drill work", async () => {
    const calls: string[] = [];

    await expect(runBackupDrillWithTeardown(async () => {
      calls.push("work");
      throw new Error("restore failed");
    }, async () => {
      calls.push("teardown");
    })).rejects.toThrow("restore failed");

    expect(calls).toEqual(["work", "teardown"]);
  });

  it("returns cleanup errors without failing successful drill work", async () => {
    const result = await runBackupDrillWithTeardown(async () => "ok", async () => {
      throw new Error("cleanup failed");
    });

    expect(result).toEqual({ result: "ok", cleanupError: "cleanup failed" });
  });
});
