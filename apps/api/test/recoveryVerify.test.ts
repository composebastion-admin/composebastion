import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const readRecoveryArtifact = vi.hoisted(() => vi.fn());
const withRecoveryArtifactLocalPath = vi.hoisted(() => vi.fn());
const withRecoveryArtifactRemotePath = vi.hoisted(() => vi.fn());
const loadWorkerBackupTarget = vi.hoisted(() => vi.fn());
const headRemoteArtifact = vi.hoisted(() => vi.fn());
const hashFile = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({ query }));
vi.mock("../src/services/recoveryArtifactStore.js", () => ({
  readRecoveryArtifact,
  withRecoveryArtifactLocalPath,
  withRecoveryArtifactRemotePath
}));
vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget,
  exportBackupTargetSecrets: vi.fn()
}));
vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  deleteRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  headRemoteArtifact,
  uploadRemoteArtifact: vi.fn()
}));
vi.mock("../src/services/recoveryStorage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/recoveryStorage.js")>()),
  hashFile
}));

const { runRecoveryVerify } = await import("../src/services/recoveryCapture.js");

const pointId = "00000000-0000-4000-8000-000000000101";
const hostId = "00000000-0000-4000-8000-000000000102";
const targetId = "00000000-0000-4000-8000-000000000103";
const now = new Date("2026-07-09T12:00:00.000Z");
const checksum = "sha256:acceptance";

const pointRow = {
  id: pointId,
  host_id: hostId,
  name: "Remote only",
  app_identity: { kind: "standalone", containerIds: ["web"] },
  trigger_kind: "manual",
  status: "completed",
  backup_target_id: targetId,
  legacy_volume_backup_id: null,
  artifact_count: 2,
  completed_artifact_count: 2,
  total_bytes: 20,
  error: null,
  metadata: {},
  created_at: now,
  started_at: now,
  completed_at: now
};

function artifactRow(kind: "metadata" | "volume", storageKey: string) {
  return {
    id: kind === "metadata" ? "00000000-0000-4000-8000-000000000104" : "00000000-0000-4000-8000-000000000105",
    recovery_point_id: pointId,
    kind,
    backup_target_id: targetId,
    storage_key: storageKey,
    size_bytes: 10,
    checksum,
    status: "completed",
    error: null,
    metadata: {
      remoteObjectKey: `candidate/${pointId}/${storageKey}`,
      localCachePolicy: "remote_only"
    },
    created_at: now,
    completed_at: now
  };
}

describe("remote-only recovery verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const artifacts = [artifactRow("metadata", "manifest.json"), artifactRow("volume", "volumes/data.tar.gz")];
    query
      .mockResolvedValueOnce({ rows: [pointRow] })
      .mockResolvedValueOnce({ rows: artifacts })
      .mockResolvedValueOnce({ rows: [] });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({ artifacts: [{ storageKey: "volumes/data.tar.gz" }] })));
    withRecoveryArtifactLocalPath.mockImplementation(async (_point, artifact, useArtifact) =>
      useArtifact(`/rehydrated/${artifact.storageKey}`)
    );
    withRecoveryArtifactRemotePath.mockImplementation(async (_point, artifact, useArtifact) =>
      useArtifact(`/remote-verified/${artifact.storageKey}`)
    );
    hashFile.mockResolvedValue(checksum);
    loadWorkerBackupTarget.mockResolvedValue({
      kind: "s3",
      enabled: true,
      localCachePolicy: "remote_only",
      s3: { config: { bucket: "acceptance" }, credentials: { accessKeyId: "key", secretAccessKey: "secret" } }
    });
    headRemoteArtifact.mockResolvedValue({ sizeBytes: 10, checksum });
  });

  it("rehydrates every missing artifact before local checksum validation", async () => {
    await expect(runRecoveryVerify(hostId, pointId)).resolves.toMatchObject({
      recoveryPointId: pointId,
      verifyStatus: "completed",
      artifactCount: 2
    });

    expect(readRecoveryArtifact).toHaveBeenCalledTimes(1);
    expect(withRecoveryArtifactLocalPath).toHaveBeenCalledTimes(2);
    expect(hashFile).toHaveBeenCalledWith("/rehydrated/manifest.json");
    expect(hashFile).toHaveBeenCalledWith("/rehydrated/volumes/data.tar.gz");
    expect(headRemoteArtifact).toHaveBeenCalledTimes(2);
    expect(withRecoveryArtifactRemotePath).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[2]?.[1]?.[1]).toContain("verifiedAt");
  });

  it("does not certify a retained local copy after remote verification failed and removed the remote object", async () => {
    const artifacts = [
      {
        ...artifactRow("metadata", "manifest.json"),
        metadata: {
          localCachePolicy: "keep",
          localCacheRemoved: false,
          remoteVerificationError: "Downloaded remote artifact manifest.json checksum verification failed",
          remoteVerified: false,
          remoteObjectDeletedAfterFailedVerification: true
        }
      },
      artifactRow("volume", "volumes/data.tar.gz")
    ];
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [pointRow] })
      .mockResolvedValueOnce({ rows: artifacts })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runRecoveryVerify(hostId, pointId)).rejects.toThrow(
      "manifest.json remote verification failed"
    );

    expect(withRecoveryArtifactLocalPath).toHaveBeenCalledTimes(2);
    expect(hashFile).toHaveBeenCalledTimes(3);
    expect(headRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(withRecoveryArtifactRemotePath).toHaveBeenCalledTimes(1);
    expect(JSON.parse(query.mock.calls[2]?.[1]?.[1])).toMatchObject({
      verifyStatus: "failed",
      verifyFailures: ["manifest.json remote verification failed"]
    });
  });

  it("does not certify a remote-backed artifact whose remote locator is missing", async () => {
    const artifacts = [
      {
        ...artifactRow("metadata", "manifest.json"),
        metadata: { localCachePolicy: "keep" }
      },
      artifactRow("volume", "volumes/data.tar.gz")
    ];
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [pointRow] })
      .mockResolvedValueOnce({ rows: artifacts })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runRecoveryVerify(hostId, pointId)).rejects.toThrow(
      "manifest.json remote locator missing"
    );

    expect(loadWorkerBackupTarget).toHaveBeenCalledTimes(1);
    expect(headRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(JSON.parse(query.mock.calls[2]?.[1]?.[1])).toMatchObject({
      verifyStatus: "failed",
      verifyFailures: ["manifest.json remote locator missing"]
    });
  });

  it("allows local backup targets to verify without remote locators", async () => {
    const artifacts = [
      {
        ...artifactRow("metadata", "manifest.json"),
        metadata: { backupTargetKind: "local" }
      },
      {
        ...artifactRow("volume", "volumes/data.tar.gz"),
        metadata: { backupTargetKind: "local" }
      }
    ];
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [pointRow] })
      .mockResolvedValueOnce({ rows: artifacts })
      .mockResolvedValueOnce({ rows: [] });
    loadWorkerBackupTarget.mockResolvedValue({
      kind: "local",
      enabled: true,
      localCachePolicy: "keep",
      config: {}
    });

    await expect(runRecoveryVerify(hostId, pointId)).resolves.toMatchObject({
      recoveryPointId: pointId,
      verifyStatus: "completed",
      artifactCount: 2
    });

    expect(loadWorkerBackupTarget).toHaveBeenCalledTimes(1);
    expect(headRemoteArtifact).not.toHaveBeenCalled();
    expect(withRecoveryArtifactRemotePath).not.toHaveBeenCalled();
  });

  it("verifies the exact URL-shaped remote locators stored in artifact metadata", async () => {
    const manifestLocator =
      "https:/storage-user:storage-password@archive.example.test/root/manifest.json";
    const volumeLocator =
      "https:/storage-user:storage-password@archive.example.test/root/data.tar.gz";
    const artifacts = [
      {
        ...artifactRow("metadata", "manifest.json"),
        metadata: { remoteObjectKey: manifestLocator, localCachePolicy: "remote_only" }
      },
      {
        ...artifactRow("volume", "volumes/data.tar.gz"),
        metadata: { remoteObjectKey: volumeLocator, localCachePolicy: "remote_only" }
      }
    ];
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [pointRow] })
      .mockResolvedValueOnce({ rows: artifacts })
      .mockResolvedValueOnce({ rows: [] });

    await expect(runRecoveryVerify(hostId, pointId)).resolves.toMatchObject({
      verifyStatus: "completed"
    });

    expect(headRemoteArtifact.mock.calls.map(([, key]) => key)).toEqual([
      manifestLocator,
      volumeLocator
    ]);
  });

  it("does not certify same-size corrupt remote bytes when HEAD echoes the expected checksum", async () => {
    let remoteHashCount = 0;
    hashFile.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith("/remote-verified/")) {
        remoteHashCount += 1;
        return remoteHashCount === 1 ? "sha256:corrupt-remote-body" : checksum;
      }
      return checksum;
    });

    await expect(runRecoveryVerify(hostId, pointId)).rejects.toThrow(
      "manifest.json remote verify failed (downloaded remote checksum mismatch)"
    );

    expect(headRemoteArtifact).toHaveBeenCalledTimes(2);
    expect(withRecoveryArtifactRemotePath).toHaveBeenCalledTimes(2);
    expect(JSON.parse(query.mock.calls[2]?.[1]?.[1])).toMatchObject({
      verifyStatus: "failed",
      verifyFailures: [
        "manifest.json remote verify failed (downloaded remote checksum mismatch)"
      ]
    });
  });
});
