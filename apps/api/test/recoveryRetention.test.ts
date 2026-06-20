import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const deleteRecoveryPointLocalFiles = vi.fn();
const deleteRecoveryPointRemoteArtifacts = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  deleteRecoveryPointLocalFiles: (...args: unknown[]) => deleteRecoveryPointLocalFiles(...args)
}));

vi.mock("../src/services/recoveryArtifactDelete.js", () => ({
  deleteRecoveryPointRemoteArtifacts: (...args: unknown[]) => deleteRecoveryPointRemoteArtifacts(...args)
}));

const currentPoint = {
  id: "00000000-0000-4000-8000-000000000020",
  hostId: "00000000-0000-4000-8000-000000000021",
  name: "Nightly",
  appIdentity: { kind: "compose", projectName: "demoapp" },
  triggerKind: "scheduled",
  status: "completed",
  backupTargetId: null,
  legacyVolumeBackupId: null,
  artifactCount: 1,
  completedArtifactCount: 1,
  totalBytes: null,
  error: null,
  metadata: {
    scheduleId: "00000000-0000-4000-8000-000000000022",
    retentionCount: 2
  },
  createdAt: "2026-06-15T12:00:00.000Z",
  startedAt: "2026-06-15T12:00:00.000Z",
  completedAt: "2026-06-15T12:00:00.000Z",
  artifacts: []
} as const;

function oldPointRow(id: string) {
  return {
    id,
    host_id: currentPoint.hostId,
    name: "Old Nightly",
    app_identity: currentPoint.appIdentity,
    trigger_kind: "scheduled",
    status: "completed",
    backup_target_id: "00000000-0000-4000-8000-000000000026",
    legacy_volume_backup_id: null,
    artifact_count: 1,
    completed_artifact_count: 1,
    total_bytes: null,
    error: null,
    metadata: currentPoint.metadata,
    created_at: new Date("2026-06-14T12:00:00.000Z"),
    started_at: new Date("2026-06-14T12:00:00.000Z"),
    completed_at: new Date("2026-06-14T12:00:00.000Z")
  };
}

function artifactRow(recoveryPointId: string) {
  return {
    id: "00000000-0000-4000-8000-000000000027",
    recovery_point_id: recoveryPointId,
    kind: "metadata",
    backup_target_id: "00000000-0000-4000-8000-000000000026",
    storage_key: "manifest.json",
    size_bytes: 12,
    checksum: "sha256:manifest",
    status: "completed",
    error: null,
    metadata: { remoteObjectKey: `stored/${recoveryPointId}/manifest.json` },
    created_at: new Date("2026-06-14T12:00:00.000Z"),
    completed_at: new Date("2026-06-14T12:00:00.000Z")
  };
}

describe("scheduled recovery retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteRecoveryPointLocalFiles.mockResolvedValue(undefined);
    deleteRecoveryPointRemoteArtifacts.mockResolvedValue({ deletedObjectKeys: [] });
  });

  it("deletes recovery points beyond the scheduled retention count", async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id") && sql.includes("OFFSET")) {
        return {
          rows: [
            { id: "00000000-0000-4000-8000-000000000023" },
            { id: "00000000-0000-4000-8000-000000000024" }
          ]
        };
      }
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") {
        return { rows: [oldPointRow(String(params?.[0]))] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [artifactRow(String(params?.[0]))] };
      }
      return { rows: [] };
    });

    const { enforceScheduledRecoveryRetention } = await import("../src/services/recoveryRetention.js");
    const result = await enforceScheduledRecoveryRetention(currentPoint);

    expect(result.deletedIds).toEqual([
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024"
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("trigger_kind = 'scheduled'"),
      ["00000000-0000-4000-8000-000000000022", 2]
    );
    expect(String(query.mock.calls[0][0])).toContain("metadata->>'scheduleId'");
    expect(deleteRecoveryPointRemoteArtifacts).toHaveBeenCalledTimes(2);
    expect(deleteRecoveryPointLocalFiles).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM recovery_points WHERE id = $1",
      ["00000000-0000-4000-8000-000000000023"]
    );
    const firstRemoteOrder = deleteRecoveryPointRemoteArtifacts.mock.invocationCallOrder[0];
    const firstLocalOrder = deleteRecoveryPointLocalFiles.mock.invocationCallOrder[0];
    const firstDbDeleteCallIndex = query.mock.calls.findIndex((call) =>
      call[0] === "DELETE FROM recovery_points WHERE id = $1"
      && (call[1] as string[])[0] === "00000000-0000-4000-8000-000000000023"
    );
    expect(firstRemoteOrder).toBeLessThan(firstLocalOrder);
    expect(firstLocalOrder).toBeLessThan(query.mock.invocationCallOrder[firstDbDeleteCallIndex]);
  });

  it("does nothing for points without schedule retention metadata", async () => {
    const { enforceScheduledRecoveryRetention } = await import("../src/services/recoveryRetention.js");
    const result = await enforceScheduledRecoveryRetention({
      ...currentPoint,
      metadata: {}
    });

    expect(result.deletedIds).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(deleteRecoveryPointLocalFiles).not.toHaveBeenCalled();
  });

  it("keeps database rows when local deletion fails and records context", async () => {
    const oldId = "00000000-0000-4000-8000-000000000025";
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id") && sql.includes("OFFSET")) return { rows: [{ id: oldId }] };
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [oldPointRow(String(params?.[0]))] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow(String(params?.[0]))] };
      return { rows: [] };
    });
    deleteRecoveryPointLocalFiles.mockRejectedValue(new Error("local rm failed"));

    const { enforceScheduledRecoveryRetention } = await import("../src/services/recoveryRetention.js");
    const result = await enforceScheduledRecoveryRetention(currentPoint);

    expect(result.deletedIds).toEqual([]);
    expect(result.failures[0]).toContain("local rm failed");
    expect(deleteRecoveryPointRemoteArtifacts).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith("DELETE FROM recovery_points WHERE id = $1", [oldId]);
    const updateCall = query.mock.calls.find((call) => String(call[0]).includes("UPDATE recovery_points"));
    expect(updateCall?.[1]).toEqual([currentPoint.id, expect.stringContaining("local rm failed")]);
  });

  it("keeps database rows when remote deletion fails and records context", async () => {
    const oldId = "00000000-0000-4000-8000-000000000028";
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id") && sql.includes("OFFSET")) return { rows: [{ id: oldId }] };
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [oldPointRow(String(params?.[0]))] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow(String(params?.[0]))] };
      return { rows: [] };
    });
    deleteRecoveryPointRemoteArtifacts.mockRejectedValue(new Error("s3 delete failed"));

    const { enforceScheduledRecoveryRetention } = await import("../src/services/recoveryRetention.js");
    const result = await enforceScheduledRecoveryRetention(currentPoint);

    expect(result.deletedIds).toEqual([]);
    expect(result.failures[0]).toContain("s3 delete failed");
    expect(deleteRecoveryPointLocalFiles).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith("DELETE FROM recovery_points WHERE id = $1", [oldId]);
    const updateCall = query.mock.calls.find((call) => String(call[0]).includes("UPDATE recovery_points"));
    expect(updateCall?.[1]).toEqual([currentPoint.id, expect.stringContaining("s3 delete failed")]);
  });
});
