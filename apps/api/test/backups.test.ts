import path from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { buildBackupHealthAttentionItems, safeBackupPath } from "../src/services/backups.js";

describe("backup paths", () => {
  it("keeps backup files under BACKUP_DIR", () => {
    const backupPath = safeBackupPath("volume.tar.gz");
    expect(backupPath).toBe(path.resolve(env.BACKUP_DIR, "volume.tar.gz"));
  });

  it("rejects path traversal", () => {
    expect(() => safeBackupPath("../outside.tar.gz")).toThrow("escapes backup directory");
  });
});

describe("backup health attention", () => {
  const now = new Date("2026-06-21T12:00:00.000Z");
  const baseRow = {
    id: "00000000-0000-4000-8000-000000000001",
    host_id: "00000000-0000-4000-8000-000000000002",
    host_name: "prod-a",
    host_hostname: "prod-a.local",
    kind: "volume" as const,
    volume_name: "app_data",
    source_path: null,
    status: "completed" as const,
    created_at: "2026-06-21T10:00:00.000Z",
    completed_at: "2026-06-21T10:05:00.000Z",
    verified_at: "2026-06-21T10:10:00.000Z",
    last_drill_at: "2026-06-21T10:20:00.000Z"
  };

  it("flags failed and partial backups before proof reminders", () => {
    const items = buildBackupHealthAttentionItems([
      { ...baseRow, id: "00000000-0000-4000-8000-000000000003", status: "failed" as const },
      { ...baseRow, id: "00000000-0000-4000-8000-000000000004", status: "partial" as const, verified_at: null, last_drill_at: null },
      { ...baseRow, id: "00000000-0000-4000-8000-000000000005", verified_at: null, last_drill_at: null }
    ], now);

    expect(items.map((item) => item.reason)).toEqual([
      "failed",
      "partial",
      "never_verified",
      "never_drilled",
      "never_verified",
      "never_drilled"
    ]);
    expect(items.filter((item) => item.severity === "critical")).toHaveLength(2);
  });

  it("flags stale verification and drill proof after the proof window", () => {
    const items = buildBackupHealthAttentionItems([
      {
        ...baseRow,
        verified_at: "2026-05-01T12:00:00.000Z",
        last_drill_at: "2026-05-01T12:00:00.000Z"
      }
    ], now);

    expect(items).toEqual([
      expect.objectContaining({
        reason: "stale_verified",
        recommendedAction: "Run backup verification again."
      }),
      expect.objectContaining({
        reason: "stale_drilled",
        recommendedAction: "Run another restore drill."
      })
    ]);
  });
});
