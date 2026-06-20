import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWorkerBackupTarget = vi.fn();
const createS3Client = vi.fn();
const deleteRecoveryArtifactFromS3 = vi.fn();

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget: (...args: unknown[]) => loadWorkerBackupTarget(...args)
}));

vi.mock("../src/services/recoveryS3.js", () => ({
  createS3Client: (...args: unknown[]) => createS3Client(...args),
  deleteRecoveryArtifactFromS3: (...args: unknown[]) => deleteRecoveryArtifactFromS3(...args)
}));

const backupTargetId = "00000000-0000-4000-8000-000000000040";
const otherBackupTargetId = "00000000-0000-4000-8000-000000000041";

function point() {
  return {
    id: "00000000-0000-4000-8000-000000000042",
    hostId: "00000000-0000-4000-8000-000000000043",
    name: "Point",
    appIdentity: { kind: "standalone", containerIds: ["web"] },
    triggerKind: "manual",
    status: "completed",
    backupTargetId,
    legacyVolumeBackupId: null,
    artifactCount: 3,
    completedArtifactCount: 3,
    totalBytes: null,
    error: null,
    metadata: {},
    createdAt: "2026-06-15T12:00:00.000Z",
    startedAt: "2026-06-15T12:00:00.000Z",
    completedAt: "2026-06-15T12:00:00.000Z",
    artifacts: [
      {
        id: "00000000-0000-4000-8000-000000000044",
        recoveryPointId: "00000000-0000-4000-8000-000000000042",
        kind: "metadata",
        backupTargetId: null,
        storageKey: "manifest.json",
        sizeBytes: 1,
        checksum: null,
        status: "completed",
        error: null,
        metadata: { remoteObjectKey: "stored/key/from-db/manifest.json" },
        createdAt: "2026-06-15T12:00:00.000Z",
        completedAt: "2026-06-15T12:00:00.000Z"
      },
      {
        id: "00000000-0000-4000-8000-000000000045",
        recoveryPointId: "00000000-0000-4000-8000-000000000042",
        kind: "volume",
        backupTargetId: otherBackupTargetId,
        storageKey: "volumes/data.tar.gz",
        sizeBytes: 1,
        checksum: null,
        status: "completed",
        error: null,
        metadata: { remoteObjectKey: "other-target/exact-volume-key.tar.gz" },
        createdAt: "2026-06-15T12:00:00.000Z",
        completedAt: "2026-06-15T12:00:00.000Z"
      },
      {
        id: "00000000-0000-4000-8000-000000000046",
        recoveryPointId: "00000000-0000-4000-8000-000000000042",
        kind: "host_folder",
        backupTargetId: backupTargetId,
        storageKey: "host-folders/data.tar.gz",
        sizeBytes: 1,
        checksum: null,
        status: "completed",
        error: null,
        metadata: {},
        createdAt: "2026-06-15T12:00:00.000Z",
        completedAt: "2026-06-15T12:00:00.000Z"
      }
    ]
  } as const;
}

describe("recovery artifact remote deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadWorkerBackupTarget.mockImplementation(async (id: string) => ({
      kind: "s3",
      enabled: true,
      s3: {
        config: { bucket: id === backupTargetId ? "primary" : "secondary" },
        credentials: { accessKeyId: "key", secretAccessKey: "secret" }
      }
    }));
    createS3Client.mockImplementation((config: { bucket: string }) => ({ bucket: config.bucket }));
    deleteRecoveryArtifactFromS3.mockResolvedValue(undefined);
  });

  it("deletes only stored remote object keys", async () => {
    const { deleteRecoveryPointRemoteArtifacts } = await import("../src/services/recoveryArtifactDelete.js");
    const result = await deleteRecoveryPointRemoteArtifacts(point() as never);

    expect(result.deletedObjectKeys).toEqual([
      "stored/key/from-db/manifest.json",
      "other-target/exact-volume-key.tar.gz"
    ]);
    expect(deleteRecoveryArtifactFromS3.mock.calls.map((call) => call[2])).toEqual([
      "stored/key/from-db/manifest.json",
      "other-target/exact-volume-key.tar.gz"
    ]);
    expect(deleteRecoveryArtifactFromS3).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.stringContaining("volumes/data.tar.gz")
    );
  });

  it("fails rather than reconstructing a key when the backup target is missing", async () => {
    const missingTargetPoint = {
      ...point(),
      backupTargetId: null,
      artifacts: [{ ...point().artifacts[0], backupTargetId: null }]
    };

    const { deleteRecoveryPointRemoteArtifacts } = await import("../src/services/recoveryArtifactDelete.js");
    await expect(deleteRecoveryPointRemoteArtifacts(missingTargetPoint as never))
      .rejects.toThrow("has a remote object but no backup target");
    expect(deleteRecoveryArtifactFromS3).not.toHaveBeenCalled();
  });
});
