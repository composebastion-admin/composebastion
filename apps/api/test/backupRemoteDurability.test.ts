import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  leaseQuery: vi.fn(),
  withTransaction: vi.fn(),
  assertActive: vi.fn(),
  withActiveLease: vi.fn(),
  getHostForWorker: vi.fn(),
  recordBackupScheduleResult: vi.fn(),
  loadWorkerBackupTarget: vi.fn(),
  assertBackupTargetS3EndpointAllowed: vi.fn(),
  deleteRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  headRemoteArtifact: vi.fn(),
  uploadRemoteArtifact: vi.fn(),
  hashFile: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: (...args: unknown[]) => mocks.mkdir(...args),
  mkdtemp: (...args: unknown[]) => mocks.mkdtemp(...args),
  rm: (...args: unknown[]) => mocks.rm(...args),
  stat: (...args: unknown[]) => mocks.stat(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.poolQuery(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/demo.js", () => ({
  isDemoHost: (host: { tags?: string[] | null }) => host.tags?.includes("demo") === true
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => mocks.getHostForWorker(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/backupFailureAlerts.js", () => ({
  notifyBackupScheduleFailure: vi.fn(),
  recordBackupScheduleResult: (...args: unknown[]) => mocks.recordBackupScheduleResult(...args)
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget: (...args: unknown[]) => mocks.loadWorkerBackupTarget(...args),
  assertBackupTargetS3EndpointAllowed: (...args: unknown[]) => mocks.assertBackupTargetS3EndpointAllowed(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => mocks.downloadRemoteArtifactAtomically(...args),
  headRemoteArtifact: (...args: unknown[]) => mocks.headRemoteArtifact(...args),
  uploadRemoteArtifact: (...args: unknown[]) => mocks.uploadRemoteArtifact(...args)
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  hashFile: (...args: unknown[]) => mocks.hashFile(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  pipeReadableToSshCommand: vi.fn(),
  runSshCommand: vi.fn(),
  streamSshCommandToFile: vi.fn()
}));

const { runBackupVerify, runVolumeBackup } = await import("../src/services/backups.js");

const backupId = "00000000-0000-4000-8000-000000000201";
const hostId = "00000000-0000-4000-8000-000000000202";
const targetId = "00000000-0000-4000-8000-000000000203";
const checksum = "sha256:remote-only-durability";
const remoteObjectKey = `backups/${backupId}/remote.tar.gz`;
const verificationDirectory = "/tmp/composebastion-backup-verify";

let backupRow: Record<string, unknown>;

const fence = {
  assertActive: (...args: unknown[]) => mocks.assertActive(...args),
  withActiveLease: (...args: unknown[]) => mocks.withActiveLease(...args)
};

describe("remote-only backup completion durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupRow = {
      id: backupId,
      host_id: hostId,
      kind: "volume",
      volume_name: "app-data",
      source_path: null,
      target_volume_name: null,
      file_name: "remote.tar.gz",
      size_bytes: null,
      checksum: null,
      backup_target_id: targetId,
      remote_object_key: null,
      encryption: "none",
      encryption_key_id: null,
      encryption_key_fingerprint: null,
      verified_at: null,
      last_drill_at: null,
      last_drill_status: null,
      status: "queued",
      error: null,
      created_at: new Date("2026-07-11T00:00:00.000Z"),
      completed_at: null,
      metadata: {}
    };

    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM backups")) return { rows: [backupRow] };
      if (sql.includes("AND remote_object_key = $2") && values) {
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[3]))
        };
      }
      return { rows: [] };
    });
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("remote_object_key") && values) {
        backupRow.status = values[1];
        backupRow.size_bytes = values[2];
        backupRow.checksum = values[3];
        backupRow.remote_object_key = values[4];
        backupRow.error = values[5];
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[6]))
        };
      }
      return { rows: [] };
    });
    mocks.assertActive.mockResolvedValue(undefined);
    mocks.withActiveLease.mockImplementation(async (callback: (client: { query: typeof mocks.leaseQuery }) => Promise<unknown>) => (
      callback({ query: mocks.leaseQuery })
    ));
    mocks.getHostForWorker.mockResolvedValue({
      public: { id: hostId, tags: ["demo"] },
      connectionMode: "agent",
      ssh: null,
      agent: null
    });
    mocks.recordBackupScheduleResult.mockResolvedValue(undefined);
    mocks.loadWorkerBackupTarget.mockResolvedValue({
      id: targetId,
      name: "Remote only",
      kind: "s3",
      enabled: true,
      config: {},
      localCachePolicy: "remote_only",
      s3: {
        config: { endpoint: "https://s3.example.test", bucket: "backups", region: "test", prefix: "", forcePathStyle: true },
        credentials: { accessKeyId: "test", secretAccessKey: "test" }
      }
    });
    mocks.assertBackupTargetS3EndpointAllowed.mockResolvedValue(undefined);
    mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
    mocks.downloadRemoteArtifactAtomically.mockResolvedValue({ sizeBytes: 64 });
    mocks.headRemoteArtifact.mockResolvedValue({
      sizeBytes: 64,
      checksum,
      etag: "verified-etag"
    });
    mocks.uploadRemoteArtifact.mockResolvedValue({
      remoteObjectKey,
      remoteBackend: "s3",
      remoteSizeBytes: 64,
      remoteEtag: "etag"
    });
    mocks.hashFile.mockResolvedValue(checksum);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.mkdtemp.mockResolvedValue(verificationDirectory);
    mocks.rm.mockResolvedValue(undefined);
    mocks.stat.mockResolvedValue({ size: 64 });
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("commits the remote locator and integrity metadata through the lease before deleting the local artifact", async () => {
    const events: string[] = [];
    mocks.uploadRemoteArtifact.mockImplementationOnce(async () => {
      events.push("upload");
      return {
        remoteObjectKey,
        remoteBackend: "s3",
        remoteSizeBytes: 64,
        remoteEtag: "etag"
      };
    });
    mocks.headRemoteArtifact.mockImplementationOnce(async () => {
      events.push("verify");
      return {
        sizeBytes: 64,
        checksum,
        etag: "verified-etag"
      };
    });
    mocks.downloadRemoteArtifactAtomically.mockImplementationOnce(async () => {
      events.push("download");
      return { sizeBytes: 64 };
    });
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("remote_object_key") && values) {
        events.push("durable-update");
        expect(values.slice(1, 6)).toEqual(["completed", 64, checksum, remoteObjectKey, null]);
        expect(JSON.parse(String(values[6]))).toMatchObject({
          remoteBackend: "s3",
          remoteSizeBytes: 64,
          remoteEtag: "verified-etag",
          remoteChecksum: checksum,
          remoteDeclaredChecksum: checksum,
          remoteVerifiedAt: expect.any(String),
          localCachePolicy: "remote_only"
        });
        backupRow = {
          ...backupRow,
          status: values[1],
          size_bytes: values[2],
          checksum: values[3],
          remote_object_key: values[4],
          error: values[5],
          metadata: JSON.parse(String(values[6]))
        };
      }
      return { rows: [] };
    });
    mocks.rm.mockImplementation(async (target: string) => {
      events.push(target === verificationDirectory ? "verify-cleanup" : "cleanup");
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    expect(events).toEqual([
      "upload",
      "verify",
      "download",
      "verify-cleanup",
      "durable-update",
      "cleanup"
    ]);
  });

  it("rejects same-size S3 content when HEAD only echoes the submitted checksum metadata", async () => {
    mocks.headRemoteArtifact.mockResolvedValueOnce({
      sizeBytes: 64,
      checksum,
      etag: "echoed-metadata"
    });
    mocks.hashFile
      .mockResolvedValueOnce(checksum)
      .mockResolvedValueOnce("sha256:corrupt-remote-body");

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(mocks.downloadRemoteArtifactAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "s3" }),
      remoteObjectKey,
      `${verificationDirectory}/artifact`
    );
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "s3" }),
      remoteObjectKey
    );
    expect(mocks.rm.mock.calls.some(([target]) => target !== verificationDirectory)).toBe(false);
    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      error: expect.stringContaining("downloaded remote checksum mismatch")
    });
  });

  it("retains the local S3 artifact and marks the backup partial when the independent HEAD size is wrong", async () => {
    mocks.headRemoteArtifact.mockResolvedValueOnce({
      sizeBytes: 63,
      checksum,
      etag: "wrong-size"
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "s3" }),
      remoteObjectKey
    );
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      error: expect.stringContaining("remote size mismatch")
    });
  });

  it("retains the local rclone artifact and marks the backup partial when the remote checksum is wrong", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValueOnce({
      id: targetId,
      name: "SMB remote only",
      kind: "rclone",
      enabled: true,
      config: {},
      localCachePolicy: "remote_only",
      rclone: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "backups",
        credentials: { password: "test" }
      }
    });
    mocks.uploadRemoteArtifact.mockResolvedValueOnce({
      remoteObjectKey,
      remoteBackend: "rclone",
      remoteSizeBytes: 64,
      remoteEtag: null
    });
    mocks.headRemoteArtifact.mockResolvedValueOnce({
      sizeBytes: 64,
      checksum: "sha256:wrong",
      etag: null
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rclone" }),
      remoteObjectKey
    );
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      error: expect.stringContaining("remote checksum mismatch")
    });
  });

  it("retains the local artifact when the fenced completion update fails after upload", async () => {
    const fenceFailure = new Error("active lease was lost");
    mocks.leaseQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("remote_object_key") || sql.includes("status = 'failed'")) throw fenceFailure;
      return { rows: [] };
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).rejects.toThrow("active lease was lost");

    expect(mocks.uploadRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.rm.mock.calls.every(([target]) => target === verificationDirectory)).toBe(true);
    expect(mocks.poolQuery.mock.calls.some((call) => String(call[0]).includes("AND remote_object_key = $2"))).toBe(false);
  });

  it("keeps a committed remote backup valid and records a post-commit local cleanup failure", async () => {
    mocks.rm.mockImplementation(async (target: string) => {
      if (target === verificationDirectory) return;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    const cleanupUpdate = mocks.poolQuery.mock.calls.find((call) => String(call[0]).includes("AND remote_object_key = $2"));
    expect(cleanupUpdate?.[1]?.slice(0, 3)).toEqual([backupId, remoteObjectKey, checksum]);
    expect(JSON.parse(String(cleanupUpdate?.[1]?.[3]))).toEqual({ localCacheCleanupError: "permission denied" });
    expect(mocks.leaseQuery.mock.calls.some((call) => String(call[0]).includes("status = 'failed'"))).toBe(false);
    expect(backupRow).toMatchObject({
      status: "completed",
      checksum,
      remote_object_key: remoteObjectKey,
      metadata: { localCacheCleanupError: "permission denied" }
    });
  });

  it("does not downgrade a committed backup when post-commit schedule and retention bookkeeping fail", async () => {
    backupRow.metadata = {
      scheduleId: "00000000-0000-4000-8000-000000000204",
      retentionCount: 3
    };
    mocks.recordBackupScheduleResult.mockRejectedValueOnce(new Error("schedule database unavailable"));
    let backupReadCount = 0;
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM backups")) {
        backupReadCount += 1;
        if (backupReadCount > 2) throw new Error("post-commit read failed");
        return { rows: [backupRow] };
      }
      if (sql.includes("metadata->>'scheduleId'")) {
        throw new Error("retention database unavailable");
      }
      if (sql.includes("remote_object_key IS NOT DISTINCT FROM") && values) {
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[4]))
        };
      }
      return { rows: [] };
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    expect(backupReadCount).toBe(2);
    expect(mocks.recordBackupScheduleResult).toHaveBeenCalledWith(
      backupRow.metadata.scheduleId,
      "completed",
      null
    );
    const annotations = mocks.poolQuery.mock.calls
      .filter((call) => String(call[0]).includes("remote_object_key IS NOT DISTINCT FROM"))
      .map((call) => JSON.parse(String(call[1]?.[4])));
    expect(annotations).toEqual([
      { scheduleResultError: "schedule database unavailable" },
      { retentionCleanupError: "retention database unavailable" }
    ]);
    expect(mocks.leaseQuery.mock.calls.some((call) => String(call[0]).includes("status = 'failed'"))).toBe(false);
    expect(backupRow).toMatchObject({
      status: "completed",
      checksum,
      remote_object_key: remoteObjectKey,
      metadata: {
        scheduleResultError: "schedule database unavailable",
        retentionCleanupError: "retention database unavailable"
      }
    });
  });

  describe("independent remote verification", () => {
    beforeEach(() => {
      backupRow = {
        ...backupRow,
        size_bytes: 64,
        checksum,
        remote_object_key: remoteObjectKey,
        status: "completed",
        completed_at: new Date("2026-07-11T00:05:00.000Z"),
        metadata: { localCachePolicy: "retain_local" }
      };
    });

    it("downloads, hashes, and cleans the exact remote object while retaining the local copy", async () => {
      await expect(runBackupVerify(hostId, backupId)).resolves.toMatchObject({
        backupId,
        checksum
      });

      expect(mocks.headRemoteArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ id: targetId }),
        remoteObjectKey
      );
      expect(mocks.mkdtemp).toHaveBeenCalledWith(
        expect.stringContaining(".composebastion-remote-verify-")
      );
      expect(mocks.downloadRemoteArtifactAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ id: targetId }),
        remoteObjectKey,
        `${verificationDirectory}/artifact`
      );
      expect(mocks.rm).toHaveBeenCalledTimes(1);
      expect(mocks.rm).toHaveBeenCalledWith(verificationDirectory, {
        recursive: true,
        force: true
      });
      const verifyUpdate = mocks.poolQuery.mock.calls.find((call) =>
        String(call[0]).includes("SET verified_at")
      );
      expect(JSON.parse(String(verifyUpdate?.[1]?.[2]))).toMatchObject({
        verifyStatus: "completed",
        verifyFailures: []
      });
    });

    it("rejects same-size corrupt remote bytes even when HEAD echoes the expected checksum", async () => {
      mocks.headRemoteArtifact.mockResolvedValueOnce({
        sizeBytes: 64,
        checksum,
        etag: "echoed-metadata"
      });
      mocks.hashFile
        .mockResolvedValueOnce(checksum)
        .mockResolvedValueOnce(checksum)
        .mockResolvedValueOnce("sha256:corrupt-remote-body");

      await expect(runBackupVerify(hostId, backupId))
        .rejects.toThrow("downloaded remote checksum mismatch");

      expect(mocks.downloadRemoteArtifactAtomically).toHaveBeenCalledWith(
        expect.objectContaining({ id: targetId }),
        remoteObjectKey,
        `${verificationDirectory}/artifact`
      );
      expect(mocks.rm).toHaveBeenCalledTimes(1);
      expect(mocks.rm).toHaveBeenCalledWith(verificationDirectory, {
        recursive: true,
        force: true
      });
      expect(mocks.rm).not.toHaveBeenCalledWith(
        expect.stringMatching(/remote\.tar\.gz$/),
        expect.anything()
      );
      const verifyUpdate = mocks.poolQuery.mock.calls.find((call) =>
        String(call[0]).includes("SET verified_at")
      );
      expect(JSON.parse(String(verifyUpdate?.[1]?.[2]))).toMatchObject({
        verifyStatus: "failed",
        verifyFailures: [
          expect.stringContaining("downloaded remote checksum mismatch")
        ]
      });
    });
  });
});
