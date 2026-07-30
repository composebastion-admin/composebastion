import { beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  leaseQuery: vi.fn(),
  withTransaction: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn(),
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
  buildRemoteObjectKey: vi.fn(),
  hashFile: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  utimes: vi.fn(),
  writeFile: vi.fn(),
  beginRemoteArtifactWriteIntent: vi.fn(),
  clearRemoteArtifactWriteIntent: vi.fn(),
  recordRemoteArtifactOrphan: vi.fn(),
  releaseRemoteArtifactWriteIntent: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  copyFile: (...args: unknown[]) => mocks.copyFile(...args),
  mkdir: (...args: unknown[]) => mocks.mkdir(...args),
  mkdtemp: (...args: unknown[]) => mocks.mkdtemp(...args),
  rename: (...args: unknown[]) => mocks.rename(...args),
  rm: (...args: unknown[]) => mocks.rm(...args),
  stat: (...args: unknown[]) => mocks.stat(...args),
  unlink: (...args: unknown[]) => mocks.unlink(...args),
  utimes: (...args: unknown[]) => mocks.utimes(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args)
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  createWriteStream: vi.fn(() => new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  }))
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
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
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
  buildRemoteObjectKey: (...args: unknown[]) => mocks.buildRemoteObjectKey(...args),
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => mocks.downloadRemoteArtifactAtomically(...args),
  headRemoteArtifact: (...args: unknown[]) => mocks.headRemoteArtifact(...args),
  uploadRemoteArtifact: (...args: unknown[]) => mocks.uploadRemoteArtifact(...args)
}));

vi.mock("../src/services/recoveryRemoteOrphans.js", () => ({
  beginRemoteArtifactWriteIntent: (...args: unknown[]) => mocks.beginRemoteArtifactWriteIntent(...args),
  clearRemoteArtifactWriteIntent: (...args: unknown[]) => mocks.clearRemoteArtifactWriteIntent(...args),
  recordRemoteArtifactOrphan: (...args: unknown[]) => mocks.recordRemoteArtifactOrphan(...args),
  releaseRemoteArtifactWriteIntent: (...args: unknown[]) => mocks.releaseRemoteArtifactWriteIntent(...args)
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  hashFile: (...args: unknown[]) => mocks.hashFile(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  pipeReadableToSshCommand: vi.fn(),
  runSshCommand: vi.fn(),
  streamSshCommandToFile: vi.fn()
}));

const { deleteBackup, runBackupVerify, runVolumeBackup } = await import("../src/services/backups.js");

const backupId = "00000000-0000-4000-8000-000000000201";
const hostId = "00000000-0000-4000-8000-000000000202";
const targetId = "00000000-0000-4000-8000-000000000203";
const checksum = "sha256:remote-only-durability";
const remoteObjectKey = `backups/${backupId}/remote.tar.gz`;
const verificationDirectory = "/tmp/.composebastion-verify-test";

let backupRow: Record<string, unknown>;
let activeDeleteJob = false;

const fence = {
  assertActive: (...args: unknown[]) => mocks.assertActive(...args),
  withActiveLease: (...args: unknown[]) => mocks.withActiveLease(...args)
};

async function defaultLeaseQuery(sql: string, values: unknown[] = []) {
  if (sql.includes("SET status = 'running'")) {
    backupRow.status = "running";
    backupRow.metadata = {
      ...(backupRow.metadata as Record<string, unknown>),
      ...JSON.parse(String(values[1]))
    };
    return { rows: [{ id: backupId }], rowCount: 1 };
  }
  if (sql.includes("SELECT metadata FROM backups")) {
    return { rows: [{ metadata: backupRow.metadata }], rowCount: 1 };
  }
  if (sql.includes("SET status = $3")) {
    backupRow.status = values[2];
    backupRow.size_bytes = values[3];
    backupRow.checksum = values[4];
    backupRow.remote_object_key = values[5];
    backupRow.error = values[6];
    backupRow.metadata = {
      ...(backupRow.metadata as Record<string, unknown>),
      ...JSON.parse(String(values[7]))
    };
    return { rows: [{ id: backupId }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

describe("remote-only backup completion durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeleteJob = false;
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
      if (sql.includes("UPDATE backups backup")) {
        return { rows: activeDeleteJob ? [] : [{ id: backupId }] };
      }
      if (sql.includes("FROM operation_jobs")) {
        return { rows: activeDeleteJob ? [{ id: "active-job" }] : [] };
      }
      if (sql.includes("SELECT * FROM backups")) return { rows: [backupRow] };
      if (sql.includes("SET metadata = metadata || $2::jsonb") && values) {
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[1]))
        };
        return { rows: [{ id: backupId }] };
      }
      if (
        sql.includes("metadata->>'backupCaptureAttemptToken' = $2")
        && values?.[2]
        && String(values[2]).includes("backupCaptureAttemptCleanupError")
      ) {
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[2]))
        };
        return { rows: [{ id: backupId }], rowCount: 1 };
      }
      if (sql.includes("'remoteCommitError'") && values) {
        const previousKeys = Array.isArray((backupRow.metadata as Record<string, unknown>).orphanRemoteObjectKeys)
          ? (backupRow.metadata as Record<string, unknown>).orphanRemoteObjectKeys as string[]
          : [];
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          orphanRemoteObjectKey: values[1],
          orphanRemoteObjectKeys: [...new Set([...previousKeys, String(values[1])])],
          orphanRemoteBackend: values[2],
          orphanBackupTargetId: values[3],
          orphanCleanupError: values[4],
          remoteCommitError: values[5]
        };
        return { rows: [{ id: backupId }] };
      }
      if (sql.includes("AND remote_object_key = $2") && values) {
        backupRow.metadata = {
          ...(backupRow.metadata as Record<string, unknown>),
          ...JSON.parse(String(values[3]))
        };
      }
      if (sql.includes("DELETE FROM backups")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });
    mocks.withTransaction.mockImplementation(async (
      callback: (client: { query: typeof mocks.poolQuery }) => Promise<unknown>
    ) => callback({ query: mocks.poolQuery }));
    mocks.enqueueJobInTransaction.mockResolvedValue({ id: "queued-job" });
    mocks.notifyJobQueued.mockResolvedValue(undefined);
    mocks.leaseQuery.mockImplementation(defaultLeaseQuery);
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
    mocks.buildRemoteObjectKey.mockReturnValue(remoteObjectKey);
    mocks.beginRemoteArtifactWriteIntent.mockImplementation(async (input) => ({
      ...input,
      claimToken: "00000000-0000-4000-8000-000000000299"
    }));
    mocks.clearRemoteArtifactWriteIntent.mockResolvedValue(true);
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
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.mkdtemp.mockImplementation(async (prefix: string) => (
      prefix.includes(".composebastion-capture-")
        ? "/tmp/.composebastion-capture-unit"
        : verificationDirectory
    ));
    mocks.rename.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.stat.mockResolvedValue({ size: 64 });
    mocks.unlink.mockResolvedValue(undefined);
    mocks.utimes.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.recordRemoteArtifactOrphan.mockResolvedValue(undefined);
    mocks.releaseRemoteArtifactWriteIntent.mockResolvedValue(undefined);
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
      if (sql.includes("SET status = $3")) {
        events.push("durable-update");
        expect(values?.slice(2, 7)).toEqual(["completed", 64, checksum, remoteObjectKey, null]);
        expect(JSON.parse(String(values?.[7]))).toMatchObject({
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
          status: values?.[2],
          size_bytes: values?.[3],
          checksum: values?.[4],
          remote_object_key: values?.[5],
          error: values?.[6],
          metadata: JSON.parse(String(values?.[7]))
        };
        return { rows: [{ id: backupId }], rowCount: 1 };
      }
      return defaultLeaseQuery(sql, values);
    });
    mocks.rm.mockImplementation(async (target: string) => {
      events.push(target === verificationDirectory ? "verify-cleanup" : "cleanup");
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    expect(mocks.beginRemoteArtifactWriteIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: "backup",
        ownerId: backupId,
        backupTargetId: targetId,
        objectKey: remoteObjectKey,
        backend: "s3"
      })
    );
    expect(mocks.beginRemoteArtifactWriteIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.uploadRemoteArtifact.mock.invocationCallOrder[0]!);
    const commitCallIndex = mocks.leaseQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("SET status = $3")
    );
    expect(mocks.leaseQuery.mock.invocationCallOrder[commitCallIndex])
      .toBeLessThan(mocks.clearRemoteArtifactWriteIntent.mock.invocationCallOrder[0]!);
    expect(mocks.clearRemoteArtifactWriteIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: "backup",
        ownerId: backupId,
        objectKey: remoteObjectKey
      }),
      expect.objectContaining({ query: expect.any(Function) })
    );
    expect(events).toEqual([
      "upload",
      "verify",
      "download",
      "verify-cleanup",
      "durable-update",
      "cleanup"
    ]);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${verificationDirectory}/.composebastion-active`,
      `${process.pid}\n`,
      { flag: "wx", mode: 0o600 }
    );
    expect(mocks.uploadRemoteArtifact).toHaveBeenCalledWith(expect.objectContaining({
      namespaceId: backupId,
      storageKey: expect.stringMatching(/^attempts\/[0-9a-f-]+\/remote\.tar\.gz$/),
      localPath: "/tmp/.composebastion-capture-unit/artifact",
      checksum
    }));
  });

  it("does not start capture after a concurrent deletion claim wins", async () => {
    mocks.leaseQuery.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain("deletionClaimToken");
      return { rows: [], rowCount: 0 };
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).rejects.toMatchObject({
      statusCode: 409,
      message: "Backup is being deleted"
    });

    expect(mocks.getHostForWorker).not.toHaveBeenCalled();
    expect(mocks.uploadRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(".composebastion-active"),
      `${process.pid}\n`,
      { flag: "wx", mode: 0o600 }
    );
  });

  it("records an ambiguous upload failure after deterministic cleanup succeeds", async () => {
    mocks.uploadRemoteArtifact.mockRejectedValueOnce(Object.assign(
      new Error("Remote upload failed: socket timed out after PUT"),
      {
        code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
        uploadError: "socket timed out after PUT",
        expectedRemoteObject: { key: remoteObjectKey, backend: "s3" },
        remoteObjectDeletedAfterAmbiguousUpload: true,
        orphanRemoteObject: null
      }
    ));

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      remoteObjectKey: null
    });

    expect(backupRow).toMatchObject({
      status: "partial",
      metadata: {
        remoteUploadError: "socket timed out after PUT",
        remoteObjectDeletedAfterAmbiguousUpload: true,
        remoteVerified: false
      }
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
  });

  it("durably records the deterministic object when ambiguous upload cleanup fails", async () => {
    mocks.uploadRemoteArtifact.mockRejectedValueOnce(Object.assign(
      new Error("Remote upload failed and cleanup failed"),
      {
        code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
        uploadError: "copy committed but metadata timed out",
        expectedRemoteObject: { key: remoteObjectKey, backend: "s3" },
        remoteObjectDeletedAfterAmbiguousUpload: false,
        orphanRemoteObject: {
          key: remoteObjectKey,
          backend: "s3",
          cleanupError: "delete endpoint unavailable"
        }
      }
    ));

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      remoteObjectKey: null
    });

    expect(backupRow).toMatchObject({
      metadata: {
        remoteUploadError: "copy committed but metadata timed out",
        orphanRemoteObjectKey: remoteObjectKey,
        orphanRemoteObjectKeys: [remoteObjectKey],
        orphanRemoteBackend: "s3",
        orphanBackupTargetId: targetId,
        orphanCleanupError: "delete endpoint unavailable"
      }
    });
  });

  it("refreshes the cross-process lease while a verification directory remains active", async () => {
    vi.useFakeTimers();
    let releaseDownload!: () => void;
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    mocks.downloadRemoteArtifactAtomically.mockImplementationOnce(async () => {
      markDownloadStarted();
      await new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      return { sizeBytes: 64 };
    });

    try {
      const capture = runVolumeBackup(hostId, backupId, "app-data", fence);
      await downloadStarted;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.utimes).toHaveBeenCalledWith(
        `${verificationDirectory}/.composebastion-active`,
        expect.any(Date),
        expect.any(Date)
      );

      releaseDownload();
      await expect(capture).resolves.toMatchObject({ status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed and retains the canonical local copy when verification-directory cleanup fails", async () => {
    mocks.rm.mockImplementation(async (target: string) => {
      if (target === verificationDirectory) {
        throw Object.assign(new Error("verification cleanup denied"), { code: "EACCES" });
      }
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    expect(mocks.rm).toHaveBeenCalledTimes(2);
    expect(mocks.rm).toHaveBeenCalledWith(verificationDirectory, {
      recursive: true,
      force: true
    });
    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      error: expect.stringContaining("verification cleanup denied"),
      metadata: {
        remoteVerificationError: expect.stringContaining(
          "Remote backup verification completed but its temporary directory could not be removed"
        ),
        remoteVerified: false
      }
    });
  });

  it("preserves both verification and cleanup failures when both operations fail", async () => {
    mocks.hashFile
      .mockResolvedValueOnce(checksum)
      .mockResolvedValueOnce("sha256:corrupt-remote-body");
    mocks.rm.mockRejectedValueOnce(
      Object.assign(new Error("verification directory is locked"), { code: "EACCES" })
    );

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      metadata: {
        remoteVerificationError: expect.stringContaining("downloaded remote checksum mismatch"),
        remoteVerified: false
      }
    });
    expect((backupRow.metadata as Record<string, unknown>).remoteVerificationError)
      .toContain("verification directory is locked");
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    expect(mocks.rm).toHaveBeenCalledTimes(2);
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
    expect(mocks.rm).toHaveBeenCalledWith(
      "/tmp/.composebastion-capture-unit",
      { recursive: true, force: true }
    );
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
    expect(mocks.rm).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(
      "/tmp/.composebastion-capture-unit",
      { recursive: true, force: true }
    );
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
    expect(mocks.rm).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(
      "/tmp/.composebastion-capture-unit",
      { recursive: true, force: true }
    );
    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      error: expect.stringContaining("remote checksum mismatch")
    });
  });

  it("deletes the uncommitted remote object and retains the local artifact when the fenced completion update fails", async () => {
    const fenceFailure = new Error("active lease was lost");
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3") || sql.includes("status = 'failed'")) throw fenceFailure;
      return defaultLeaseQuery(sql, values);
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).rejects.toThrow("active lease was lost");

    expect(mocks.uploadRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    expect(mocks.rm.mock.calls.every(([target]) => target === verificationDirectory)).toBe(true);
    expect(mocks.poolQuery.mock.calls.some((call) => String(call[0]).includes("'remoteCommitError'"))).toBe(false);
  });

  it("treats a lost commit response as committed when the durable token and locator match", async () => {
    const responseLost = new Error("database response was lost after commit");
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3")) {
        await defaultLeaseQuery(sql, values);
        throw responseLost;
      }
      return defaultLeaseQuery(sql, values);
    });
    const baselinePoolQuery = mocks.poolQuery.getMockImplementation()!;
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT status, size_bytes, checksum")) {
        return { rows: [backupRow], rowCount: 1 };
      }
      return baselinePoolQuery(sql, values);
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.recordRemoteArtifactOrphan).not.toHaveBeenCalled();
    expect(mocks.writeFile.mock.calls.some(([filePath]) =>
      String(filePath).endsWith(".composebastion-reconciliation-required")
    )).toBe(false);
    expect(backupRow).toMatchObject({
      status: "completed",
      remote_object_key: remoteObjectKey,
      metadata: {
        backupCaptureCommittedToken: expect.any(String)
      }
    });
  });

  it("preserves exact non-secret sidecar evidence when both commit and status reads fail", async () => {
    const commitError = new Error("database write connection closed");
    const readError = new Error("database status read unavailable");
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3")) throw commitError;
      return defaultLeaseQuery(sql, values);
    });
    const baselinePoolQuery = mocks.poolQuery.getMockImplementation()!;
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT status, size_bytes, checksum")) throw readError;
      return baselinePoolQuery(sql, values);
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).rejects.toMatchObject({
      code: "BACKUP_CAPTURE_RECONCILIATION_REQUIRED"
    });

    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.recordRemoteArtifactOrphan).not.toHaveBeenCalled();
    const markerWrites = mocks.writeFile.mock.calls.filter(([filePath]) =>
      String(filePath).endsWith(".composebastion-reconciliation-required")
    );
    expect(markerWrites.length).toBeGreaterThan(0);
    const evidence = JSON.parse(String(markerWrites[0]?.[1]));
    expect(evidence).toMatchObject({
      reason: "capture_commit_outcome_unknown",
      backupId,
      attemptToken: expect.any(String),
      artifactPath: "/tmp/.composebastion-capture-unit/artifact",
      sizeBytes: 64,
      checksum,
      remoteObjectKey,
      backupTargetId: targetId,
      remoteBackend: "s3",
      recordedAt: expect.any(String)
    });
    expect(JSON.stringify(evidence)).not.toContain("secretAccessKey");
    expect(mocks.rm.mock.calls.every(([target]) => target === verificationDirectory)).toBe(true);
  });

  it("never publishes or downgrades when a successor token wins before the row lock", async () => {
    const successorToken = "00000000-0000-4000-8000-000000000299";
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT metadata FROM backups")) {
        backupRow.metadata = {
          backupCaptureAttemptToken: successorToken,
          successorEvidence: true
        };
        return { rows: [{ metadata: backupRow.metadata }], rowCount: 1 };
      }
      if (sql.includes("status = 'failed'")) return { rows: [], rowCount: 0 };
      return defaultLeaseQuery(sql, values);
    });
    const baselinePoolQuery = mocks.poolQuery.getMockImplementation()!;
    mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT status, size_bytes, checksum")) {
        return { rows: [backupRow], rowCount: 1 };
      }
      return baselinePoolQuery(sql, values);
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence))
      .rejects.toMatchObject({ code: "BACKUP_CAPTURE_ATTEMPT_LOST" });

    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    expect(mocks.recordRemoteArtifactOrphan).not.toHaveBeenCalled();
    expect(backupRow).toMatchObject({
      status: "running",
      remote_object_key: null,
      metadata: {
        backupCaptureAttemptToken: successorToken,
        successorEvidence: true
      }
    });
  });

  it("durably records the uncommitted remote locator when lease-loss compensation cannot delete it", async () => {
    const fenceFailure = new Error("active lease was lost");
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3") || sql.includes("status = 'failed'")) throw fenceFailure;
      return defaultLeaseQuery(sql, values);
    });
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(new Error("remote delete unavailable"));

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence))
      .rejects.toThrow("active lease was lost");

    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    const orphanUpdate = mocks.poolQuery.mock.calls.find((call) =>
      String(call[0]).includes("'remoteCommitError'")
    );
    expect(orphanUpdate?.[1]).toEqual([
      backupId,
      remoteObjectKey,
      "s3",
      targetId,
      "remote delete unavailable",
      "active lease was lost",
      expect.any(String)
    ]);
    expect(backupRow).toMatchObject({
      remote_object_key: null,
      metadata: {
        orphanRemoteObjectKey: remoteObjectKey,
        orphanRemoteObjectKeys: [remoteObjectKey],
        orphanRemoteBackend: "s3",
        orphanBackupTargetId: targetId,
        orphanCleanupError: "remote delete unavailable",
        remoteCommitError: "active lease was lost"
      }
    });
    expect(mocks.rm.mock.calls.every(([target]) => target === verificationDirectory)).toBe(true);
  });

  it("retries and records an uncommitted verification orphan when the completion fence is also lost", async () => {
    const fenceFailure = new Error("active lease was lost");
    mocks.hashFile
      .mockResolvedValueOnce(checksum)
      .mockResolvedValueOnce("sha256:corrupt-remote-body");
    mocks.deleteRemoteArtifact.mockRejectedValue(new Error("remote delete unavailable"));
    mocks.leaseQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = $3") || sql.includes("status = 'failed'")) throw fenceFailure;
      return defaultLeaseQuery(sql, values);
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence))
      .rejects.toThrow("active lease was lost");

    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(2);
    expect(backupRow).toMatchObject({
      remote_object_key: null,
      metadata: {
        orphanRemoteObjectKey: remoteObjectKey,
        orphanRemoteObjectKeys: [remoteObjectKey],
        orphanRemoteBackend: "s3",
        orphanBackupTargetId: targetId,
        orphanCleanupError: "remote delete unavailable",
        remoteCommitError: "active lease was lost"
      }
    });
  });

  it("persists a failed-verification orphan locator and deletes it on a later backup deletion", async () => {
    mocks.hashFile
      .mockResolvedValueOnce(checksum)
      .mockResolvedValueOnce("sha256:corrupt-remote-body");
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(new Error("remote delete unavailable"));

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "partial",
      checksum,
      remoteObjectKey: null
    });

    expect(backupRow).toMatchObject({
      status: "partial",
      remote_object_key: null,
      metadata: {
        remoteVerified: false,
        remoteVerificationError: "downloaded remote checksum mismatch",
        orphanRemoteObjectKey: remoteObjectKey,
        orphanRemoteObjectKeys: [remoteObjectKey],
        orphanRemoteBackend: "s3",
        orphanBackupTargetId: targetId,
        orphanCleanupError: "remote delete unavailable"
      }
    });

    mocks.deleteRemoteArtifact.mockResolvedValueOnce(undefined);
    await expect(deleteBackup(backupId)).resolves.toMatchObject({ id: backupId });
    expect(mocks.deleteRemoteArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: targetId }),
      remoteObjectKey
    );
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM backups"),
      [backupId, expect.any(String)]
    );
  });

  it.each(["queued", "running"] as const)(
    "rejects deletion while the backup is %s",
    async (status) => {
      backupRow.status = status;

      await expect(deleteBackup(backupId)).rejects.toMatchObject({ statusCode: 409 });

      expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalled();
      expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM backups"))).toBe(false);
    }
  );

  it("rejects deletion while an operation still references the backup", async () => {
    backupRow.status = "partial";
    activeDeleteJob = true;

    await expect(deleteBackup(backupId)).rejects.toMatchObject({ statusCode: 409 });

    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.unlink).not.toHaveBeenCalled();
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

    const cleanupUpdate = mocks.poolQuery.mock.calls.find((call) =>
      String(call[1]?.[2]).includes("backupCaptureAttemptCleanupError")
    );
    expect(cleanupUpdate?.[1]?.slice(0, 2)).toEqual([backupId, expect.any(String)]);
    expect(JSON.parse(String(cleanupUpdate?.[1]?.[2]))).toEqual({
      backupCaptureAttemptCleanupError: "permission denied"
    });
    expect(mocks.leaseQuery.mock.calls.some((call) => String(call[0]).includes("status = 'failed'"))).toBe(false);
    expect(backupRow).toMatchObject({
      status: "completed",
      checksum,
      remote_object_key: remoteObjectKey,
      metadata: { backupCaptureAttemptCleanupError: "permission denied" }
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
          ...JSON.parse(String(values[5]))
        };
      }
      return { rows: [] };
    });

    await expect(runVolumeBackup(hostId, backupId, "app-data", fence)).resolves.toMatchObject({
      status: "completed",
      checksum,
      remoteObjectKey
    });

    expect(backupReadCount).toBe(1);
    expect(mocks.recordBackupScheduleResult).toHaveBeenCalledWith(
      backupRow.metadata.scheduleId,
      "completed",
      null
    );
    const annotations = mocks.poolQuery.mock.calls
      .filter((call) => String(call[0]).includes("remote_object_key IS NOT DISTINCT FROM"))
      .map((call) => JSON.parse(String(call[1]?.[5])));
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

    it("does not certify a remote-backed backup whose locator is missing", async () => {
      backupRow.remote_object_key = null;

      await expect(runBackupVerify(hostId, backupId))
        .rejects.toThrow("remote locator missing");

      expect(mocks.loadWorkerBackupTarget).toHaveBeenCalledWith(targetId);
      expect(mocks.headRemoteArtifact).not.toHaveBeenCalled();
      expect(mocks.downloadRemoteArtifactAtomically).not.toHaveBeenCalled();
      const verifyUpdate = mocks.poolQuery.mock.calls.find((call) =>
        String(call[0]).includes("SET verified_at")
      );
      expect(JSON.parse(String(verifyUpdate?.[1]?.[2]))).toMatchObject({
        verifyStatus: "failed",
        verifyFailures: ["remote locator missing"]
      });
    });
  });
});
