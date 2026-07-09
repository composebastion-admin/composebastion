import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const readRecoveryArtifact = vi.hoisted(() => vi.fn());
const ensureRecoveryArtifactLocalPath = vi.hoisted(() => vi.fn());
const loadWorkerBackupTarget = vi.hoisted(() => vi.fn());
const headRemoteArtifact = vi.hoisted(() => vi.fn());
const hashFile = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({ query }));
vi.mock("../src/services/recoveryArtifactStore.js", () => ({
  readRecoveryArtifact,
  ensureRecoveryArtifactLocalPath
}));
vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget,
  exportBackupTargetSecrets: vi.fn()
}));
vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
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
    ensureRecoveryArtifactLocalPath.mockImplementation(async (_point, artifact) => `/rehydrated/${artifact.storageKey}`);
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
    expect(ensureRecoveryArtifactLocalPath).toHaveBeenCalledTimes(2);
    expect(hashFile).toHaveBeenCalledWith("/rehydrated/manifest.json");
    expect(hashFile).toHaveBeenCalledWith("/rehydrated/volumes/data.tar.gz");
    expect(headRemoteArtifact).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[2]?.[1]?.[1]).toContain("verifiedAt");
  });
});
