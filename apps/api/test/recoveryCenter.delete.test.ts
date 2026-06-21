import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const deleteRecoveryPointLocalFiles = vi.fn();
const deleteRecoveryPointRemoteArtifacts = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: vi.fn()
}));

vi.mock("../src/services/recoveryArtifactDelete.js", () => ({
  deleteRecoveryPointRemoteArtifacts: (...args: unknown[]) => deleteRecoveryPointRemoteArtifacts(...args)
}));

vi.mock("../src/services/recoveryCapture.js", () => ({
  runRecoveryCreate: vi.fn(),
  runRecoveryPointCapture: vi.fn(),
  runRecoveryVerify: vi.fn()
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  deleteRecoveryPointLocalFiles: (...args: unknown[]) => deleteRecoveryPointLocalFiles(...args)
}));

const recoveryPointId = "00000000-0000-4000-8000-000000000030";
const backupTargetId = "00000000-0000-4000-8000-000000000031";
const now = new Date("2026-06-15T12:00:00.000Z");

const recoveryPointRow = {
  id: recoveryPointId,
  host_id: "00000000-0000-4000-8000-000000000032",
  name: "Point",
  app_identity: { kind: "standalone", containerIds: ["web"] },
  trigger_kind: "manual",
  status: "completed",
  backup_target_id: backupTargetId,
  legacy_volume_backup_id: null,
  artifact_count: 1,
  completed_artifact_count: 1,
  total_bytes: null,
  error: null,
  metadata: {},
  created_at: now,
  started_at: now,
  completed_at: now
};

const artifactRow = {
  id: "00000000-0000-4000-8000-000000000033",
  recovery_point_id: recoveryPointId,
  kind: "metadata",
  backup_target_id: backupTargetId,
  storage_key: "manifest.json",
  size_bytes: 12,
  checksum: "sha256:manifest",
  status: "completed",
  error: null,
  metadata: { remoteObjectKey: "stored/recovery/manifest.json" },
  created_at: now,
  completed_at: now
};

describe("manual recovery point delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteRecoveryPointRemoteArtifacts.mockResolvedValue({ deletedObjectKeys: ["stored/recovery/manifest.json"] });
    deleteRecoveryPointLocalFiles.mockResolvedValue(undefined);
    query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      return { rows: [] };
    });
  });

  it("deletes remote artifacts before local files and database state", async () => {
    const { deleteRecoveryPoint } = await import("../src/services/recoveryCenter.js");
    await expect(deleteRecoveryPoint(recoveryPointId)).resolves.toMatchObject({ id: recoveryPointId });

    expect(deleteRecoveryPointRemoteArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      id: recoveryPointId,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ metadata: { remoteObjectKey: "stored/recovery/manifest.json" } })
      ])
    }));
    expect(deleteRecoveryPointLocalFiles).toHaveBeenCalledWith(recoveryPointId);
    expect(query).toHaveBeenCalledWith("DELETE FROM recovery_points WHERE id = $1", [recoveryPointId]);

    const dbDeleteCallIndex = query.mock.calls.findIndex((call) => call[0] === "DELETE FROM recovery_points WHERE id = $1");
    expect(deleteRecoveryPointRemoteArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(deleteRecoveryPointLocalFiles.mock.invocationCallOrder[0]);
    expect(deleteRecoveryPointLocalFiles.mock.invocationCallOrder[0])
      .toBeLessThan(query.mock.invocationCallOrder[dbDeleteCallIndex]);
  });

  it("preserves local files and database row when remote deletion fails", async () => {
    deleteRecoveryPointRemoteArtifacts.mockRejectedValue(new Error("s3 delete failed"));

    const { deleteRecoveryPoint } = await import("../src/services/recoveryCenter.js");
    await expect(deleteRecoveryPoint(recoveryPointId)).rejects.toThrow("s3 delete failed");

    expect(deleteRecoveryPointLocalFiles).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith("DELETE FROM recovery_points WHERE id = $1", [recoveryPointId]);
  });
});
