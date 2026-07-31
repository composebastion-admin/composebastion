import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionFence } from "../src/services/jobs.js";
import { decryptSecret } from "../src/services/crypto.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadWorkerBackupTarget: vi.fn(),
  buildRemoteObjectKey: vi.fn(),
  uploadRemoteArtifact: vi.fn(),
  headRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  deleteRemoteArtifact: vi.fn(),
  hashFile: vi.fn(),
  recoveryPointsRootDir: vi.fn(),
  safeRecoveryPointFile: vi.fn(),
  preserveTrackedRecoveryTemporaryDirectory: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (
    callback: (client: { query: (...args: unknown[]) => unknown }) => unknown
  ) => callback({ query: (...args: unknown[]) => mocks.query(...args) })
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget: (...args: unknown[]) => mocks.loadWorkerBackupTarget(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  buildRemoteObjectKey: (...args: unknown[]) => mocks.buildRemoteObjectKey(...args),
  uploadRemoteArtifact: (...args: unknown[]) => mocks.uploadRemoteArtifact(...args),
  headRemoteArtifact: (...args: unknown[]) => mocks.headRemoteArtifact(...args),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => mocks.downloadRemoteArtifactAtomically(...args),
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args)
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  hashFile: (...args: unknown[]) => mocks.hashFile(...args),
  recoveryPointsRootDir: () => mocks.recoveryPointsRootDir(),
  safeRecoveryPointFile: (...args: unknown[]) => mocks.safeRecoveryPointFile(...args),
  writeRecoveryPointFile: vi.fn()
}));

vi.mock("../src/services/recoveryTemporaryStorage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/recoveryTemporaryStorage.js")>(),
  preserveTrackedRecoveryTemporaryDirectory: (...args: unknown[]) =>
    mocks.preserveTrackedRecoveryTemporaryDirectory(...args)
}));

const pointId = "00000000-0000-4000-8000-000000000201";
const targetId = "00000000-0000-4000-8000-000000000202";
const artifactId = "00000000-0000-4000-8000-000000000203";
const now = new Date("2026-07-30T10:00:00.000Z");
const goodBytes = Buffer.from("verified-body");
const corruptSameSizeBytes = Buffer.from("corrupt-body!");
const captureAttempt = {
  token: "00000000-0000-4000-8000-000000000205",
  directory: ""
};

function remoteIntentQueryResult(sql: string) {
  if (sql.includes("INSERT INTO remote_artifact_orphans")) {
    return {
      rows: [{ id: "00000000-0000-4000-8000-000000000206" }],
      rowCount: 1
    };
  }
  if (
    sql.includes("DELETE FROM remote_artifact_orphans")
    || sql.includes("UPDATE remote_artifact_orphans")
  ) {
    return { rows: [], rowCount: 1 };
  }
  return null;
}

function sha256(value: Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const pointRow = {
  id: pointId,
  host_id: "00000000-0000-4000-8000-000000000204",
  name: "Remote durability",
  app_identity: { kind: "standalone", containerIds: ["web"] },
  trigger_kind: "manual",
  status: "running",
  backup_target_id: targetId,
  legacy_volume_backup_id: null,
  artifact_count: 1,
  completed_artifact_count: 1,
  total_bytes: goodBytes.length,
  error: null,
  metadata: {},
  created_at: now,
  started_at: now,
  completed_at: null
};

const artifactRow = {
  id: artifactId,
  recovery_point_id: pointId,
  kind: "metadata",
  backup_target_id: null,
  storage_key: "manifest.json",
  size_bytes: goodBytes.length,
  checksum: sha256(goodBytes),
  status: "completed",
  error: null,
  metadata: {},
  created_at: now,
  completed_at: now
};

function target(kind: "s3" | "rclone") {
  return {
    id: targetId,
    name: `${kind} vault`,
    kind,
    enabled: true,
    config: {},
    localCachePolicy: "remote_only",
    ...(kind === "s3"
      ? {
        s3: {
          config: { endpoint: "https://s3.example.com", bucket: "backups" },
          credentials: { accessKeyId: "key", secretAccessKey: "secret" }
        }
      }
      : {
        rclone: {
          provider: "smb",
          remoteName: "composebastion",
          remotePath: "backups",
          configText: "[composebastion]\ntype = smb\n",
          credentials: { password: "fixture-password" }
        }
      })
  };
}

describe("recovery capture remote durability", () => {
  let backupDirectory: string;
  let tempDirectory: string;
  let localPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    backupDirectory = await mkdtemp(path.join(os.tmpdir(), "recovery-remote-durability-"));
    tempDirectory = path.join(backupDirectory, "recovery-points");
    localPath = path.join(tempDirectory, pointId, "manifest.json");
    captureAttempt.directory = path.dirname(localPath);
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, goodBytes);

    mocks.recoveryPointsRootDir.mockReturnValue(tempDirectory);
    mocks.buildRemoteObjectKey.mockReturnValue(`${pointId}/manifest.json`);
    mocks.safeRecoveryPointFile.mockImplementation((recoveryPointId: string, storageKey: string) =>
      path.join(tempDirectory, recoveryPointId, storageKey)
    );
    mocks.hashFile.mockImplementation(async (filePath: string) => sha256(await readFile(filePath)));
    mocks.query.mockImplementation(async (sql: string) => {
      const intentResult = remoteIntentQueryResult(sql);
      if (intentResult) return intentResult;
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("SELECT metadata FROM recovery_points")) {
        return {
          rows: [{
            metadata: {
              captureAttemptToken: captureAttempt.token
            }
          }],
          rowCount: 1
        };
      }
      return { rows: [] };
    });
    mocks.uploadRemoteArtifact.mockResolvedValue({
      remoteObjectKey: `${pointId}/manifest.json`,
      remoteBackend: "s3",
      remoteSizeBytes: goodBytes.length,
      remoteEtag: "echoed-etag"
    });
    mocks.headRemoteArtifact.mockResolvedValue({
      sizeBytes: goodBytes.length,
      checksum: sha256(goodBytes),
      etag: "echoed-etag"
    });
    mocks.downloadRemoteArtifactAtomically.mockImplementation(
      async (_target: unknown, _objectKey: string, destination: string) => {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, goodBytes);
      }
    );
    mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
    mocks.preserveTrackedRecoveryTemporaryDirectory.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(backupDirectory, { recursive: true, force: true });
  });

  it.each(["s3", "rclone"] as const)(
    "rejects a same-size corrupt %s object even when HEAD echoes the expected checksum",
    async (kind) => {
      mocks.loadWorkerBackupTarget.mockResolvedValue(target(kind));
      mocks.uploadRemoteArtifact.mockResolvedValueOnce({
        remoteObjectKey: `${pointId}/manifest.json`,
        remoteBackend: kind,
        remoteSizeBytes: goodBytes.length,
        remoteEtag: "echoed-etag"
      });
      mocks.downloadRemoteArtifactAtomically.mockImplementation(
        async (_target: unknown, _objectKey: string, destination: string) => {
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, corruptSameSizeBytes);
        }
      );

      const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
      await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt)).resolves.toBe(1);

      expect(await readFile(localPath)).toEqual(goodBytes);
      expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ kind }),
        `${pointId}/manifest.json`
      );
      const failureWrite = mocks.query.mock.calls.find(([_sql, values]) =>
        Array.isArray(values)
        && values.some((value) => typeof value === "string" && value.includes("remoteVerificationError"))
      );
      const failureMetadata = JSON.parse(String(failureWrite?.[1]?.[3]));
      expect(failureMetadata.remoteVerificationError).toContain("checksum verification failed");
      expect(failureMetadata).not.toHaveProperty("remoteObjectKey");
      expect(mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE recovery_artifacts")
        && String(sql).includes("status =")
      )).toBe(false);
    }
  );

  it("records deterministic cleanup after an upload reports an ambiguous failure", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    mocks.uploadRemoteArtifact.mockRejectedValueOnce(Object.assign(
      new Error("Remote upload failed: socket timed out after PUT"),
      {
        code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
        uploadError: "socket timed out after PUT",
        expectedRemoteObject: { key: `${pointId}/manifest.json`, backend: "s3" },
        remoteObjectDeletedAfterAmbiguousUpload: true,
        orphanRemoteObject: null
      }
    ));

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt)).resolves.toBe(1);

    const failureWrite = mocks.query.mock.calls.find(([_sql, values]) =>
      Array.isArray(values)
      && typeof values[3] === "string"
      && values[3].includes("remoteObjectDeletedAfterAmbiguousUpload")
    );
    expect(JSON.parse(String(failureWrite?.[1]?.[3]))).toMatchObject({
      remoteUploadError: "socket timed out after PUT",
      remoteObjectDeletedAfterAmbiguousUpload: true,
      remoteVerified: false,
      localCacheRemoved: false
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
  });

  it("persists the deterministic orphan locator when ambiguous upload cleanup fails", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("rclone"));
    mocks.uploadRemoteArtifact.mockRejectedValueOnce(Object.assign(
      new Error("Remote upload failed and cleanup failed"),
      {
        code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
        uploadError: "copy committed but lsjson failed",
        expectedRemoteObject: { key: `${pointId}/manifest.json`, backend: "rclone" },
        remoteObjectDeletedAfterAmbiguousUpload: false,
        orphanRemoteObject: {
          key: `${pointId}/manifest.json`,
          backend: "rclone",
          cleanupError: "rclone delete unavailable"
        }
      }
    ));

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt)).resolves.toBe(1);

    const orphanWrite = mocks.query.mock.calls.find(([_sql, values]) =>
      Array.isArray(values)
      && typeof values[3] === "string"
      && values[3].includes("orphanRemoteObjectKey")
    );
    expect(orphanWrite?.[1]?.[1]).toBe(targetId);
    expect(JSON.parse(String(orphanWrite?.[1]?.[3]))).toMatchObject({
      remoteUploadError: "copy committed but lsjson failed",
      orphanRemoteObjectKey: `${pointId}/manifest.json`,
      orphanRemoteBackend: "rclone",
      orphanCleanupError: "rclone delete unavailable",
      remoteVerified: false,
      localCacheRemoved: false
    });
    const durableOrphan = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO remote_artifact_orphans")
    );
    expect(durableOrphan).toBeDefined();
    expect(JSON.parse(decryptSecret(String(durableOrphan?.[1]?.[8])))).toEqual(
      target("rclone")
    );
    expect(JSON.stringify(durableOrphan)).not.toContain("fixture-password");
  });

  it("keeps a verified locator successful when cache bookkeeping loses its lease after rm", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      const intentResult = remoteIntentQueryResult(sql);
      if (intentResult) return intentResult;
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("SELECT metadata FROM recovery_points")) {
        return {
          rows: [{ metadata: { captureAttemptToken: captureAttempt.token } }],
          rowCount: 1
        };
      }
      const metadata = typeof values?.[1] === "string" && values[1].startsWith("{")
        ? JSON.parse(values[1])
        : null;
      if (metadata?.localCacheRemoved === true) throw new Error("job lease lost during cleanup bookkeeping");
      return { rows: [] };
    });

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt)).resolves.toBe(0);

    const intentInsertIndex = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("INSERT INTO remote_artifact_orphans")
    );
    const locatorCommitIndex = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("SET backup_target_id = $2")
    );
    const intentClearIndex = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("DELETE FROM remote_artifact_orphans")
    );
    expect(mocks.query.mock.invocationCallOrder[intentInsertIndex])
      .toBeLessThan(mocks.uploadRemoteArtifact.mock.invocationCallOrder[0]!);
    expect(locatorCommitIndex).toBeGreaterThan(-1);
    expect(intentClearIndex).toBeGreaterThan(locatorCommitIndex);
    await expect(stat(localPath)).rejects.toThrow();
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    const locatorWrite = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET backup_target_id = $2")
    );
    const locatorMetadata = JSON.parse(String(locatorWrite?.[1]?.[2]));
    expect(locatorMetadata).toMatchObject({
      remoteVerified: true,
      localCachePolicy: "remote_only",
      localCacheCleanupAttempted: false
    });
    expect(locatorMetadata).not.toHaveProperty("localCacheRemoved");
    const pointSummaryWrite = mocks.query.mock.calls.find(([sql, values]) =>
      String(sql).includes("UPDATE recovery_points")
      && Array.isArray(values)
      && values.some((value) => typeof value === "string" && value.includes("remoteUploadAttempted"))
    );
    const summary = JSON.parse(String(pointSummaryWrite?.[1]?.[1]));
    expect(summary).toMatchObject({
      remoteUploadedArtifactCount: 1,
      remoteVerifiedArtifactCount: 1,
      remoteUploadFailureCount: 0,
      remoteUploadComplete: true
    });
  });

  it("retains the local artifact and deletes the remote object when fenced locator persistence fails", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("rclone"));
    mocks.uploadRemoteArtifact.mockResolvedValueOnce({
      remoteObjectKey: `${pointId}/manifest.json`,
      remoteBackend: "rclone",
      remoteSizeBytes: goodBytes.length,
      remoteEtag: null
    });
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
        callback({
          query: async (sql: string, values: unknown[] = []) => {
            if (sql.includes("SET backup_target_id = $2")) {
              throw new Error("job lease lost before locator persistence");
            }
            return mocks.query(sql, values);
          }
        })
      )
    } as unknown as JobExecutionFence;

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(
      pointId,
      targetId,
      captureAttempt,
      executionFence
    )).resolves.toBe(1);

    expect(await readFile(localPath)).toEqual(goodBytes);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("orphanRemoteObjectKey"))).toBe(false);
  });

  it("persists an orphan locator outside an expired lease when compensating remote deletion also fails", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(new Error("remote delete unavailable"));
    const leaseLost = new Error("job lease lost before locator persistence");
    let leaseExpired = false;
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (
        callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>
      ) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SET backup_target_id = $2")) leaseExpired = true;
          if (leaseExpired) throw leaseLost;
          return mocks.query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(
      pointId,
      targetId,
      captureAttempt,
      executionFence
    ))
      .rejects.toBe(leaseLost);

    expect(await readFile(localPath)).toEqual(goodBytes);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "s3" }),
      `${pointId}/manifest.json`
    );
    const orphanWrite = mocks.query.mock.calls.find(([sql, values]) =>
      String(sql).includes("UPDATE recovery_artifacts")
      && Array.isArray(values)
      && typeof values[3] === "string"
      && values[3].includes("orphanRemoteObjectKey")
    );
    expect(orphanWrite?.[1]?.[1]).toBe(targetId);
    expect(JSON.parse(String(orphanWrite?.[1]?.[3]))).toMatchObject({
      orphanRemoteObjectKey: `${pointId}/manifest.json`,
      orphanRemoteBackend: "s3",
      orphanCleanupError: "remote delete unavailable",
      remoteVerified: false,
      localCacheRemoved: false
    });
  });

  it("accepts a lost locator-commit response only when the durable attempt marker matches", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    const responseLost = new Error("locator commit response was lost");
    mocks.query.mockImplementation(async (sql: string) => {
      const intentResult = remoteIntentQueryResult(sql);
      if (intentResult) return intentResult;
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("SELECT metadata FROM recovery_points")) {
        return {
          rows: [{ metadata: { captureAttemptToken: captureAttempt.token } }],
          rowCount: 1
        };
      }
      if (sql.includes("SET backup_target_id = $2")) throw responseLost;
      if (sql.includes("SELECT backup_target_id, metadata")) {
        return {
          rows: [{
            backup_target_id: targetId,
            metadata: {
              remoteObjectKey: `${pointId}/manifest.json`,
              remoteCaptureAttemptToken: captureAttempt.token,
              remoteVerified: true
            }
          }]
        };
      }
      return { rows: [] };
    });

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt))
      .resolves.toBe(0);

    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.preserveTrackedRecoveryTemporaryDirectory).not.toHaveBeenCalled();
  });

  it("preserves exact locator evidence when commit and status reads both fail", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    mocks.query.mockImplementation(async (sql: string) => {
      const intentResult = remoteIntentQueryResult(sql);
      if (intentResult) return intentResult;
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("SELECT metadata FROM recovery_points")) {
        return {
          rows: [{ metadata: { captureAttemptToken: captureAttempt.token } }],
          rowCount: 1
        };
      }
      if (sql.includes("SET backup_target_id = $2")) {
        throw new Error("locator commit connection closed");
      }
      if (sql.includes("SELECT backup_target_id, metadata")) {
        throw new Error("locator status read unavailable");
      }
      return { rows: [] };
    });

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt))
      .rejects.toMatchObject({ code: "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED" });

    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.preserveTrackedRecoveryTemporaryDirectory).toHaveBeenCalledWith(
      captureAttempt.directory,
      {
        recoveryPointId: pointId,
        artifactId,
        attemptToken: captureAttempt.token,
        storageKey: "manifest.json",
        remoteObjectKey: `${pointId}/manifest.json`,
        remoteBackend: "s3",
        backupTargetId: targetId
      }
    );
    expect(await readFile(localPath)).toEqual(goodBytes);
  });

  it("does not publish a stale locator after a successor capture token wins", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("rclone"));
    const successorToken = "00000000-0000-4000-8000-000000000299";
    mocks.uploadRemoteArtifact.mockResolvedValueOnce({
      remoteObjectKey: `${pointId}/attempts/${captureAttempt.token}/manifest.json`,
      remoteBackend: "rclone",
      remoteSizeBytes: goodBytes.length,
      remoteEtag: null
    });
    mocks.buildRemoteObjectKey.mockReturnValueOnce(
      `${pointId}/attempts/${captureAttempt.token}/manifest.json`
    );
    mocks.query.mockImplementation(async (sql: string) => {
      const intentResult = remoteIntentQueryResult(sql);
      if (intentResult) return intentResult;
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      if (sql.includes("SELECT metadata FROM recovery_points")) {
        return {
          rows: [{
            metadata: {
              captureAttemptToken: sql.includes("FOR UPDATE")
                ? successorToken
                : captureAttempt.token,
              successorEvidence: sql.includes("FOR UPDATE")
            }
          }],
          rowCount: 1
        };
      }
      if (sql.includes("SET backup_target_id = $2")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, captureAttempt))
      .resolves.toBe(1);

    const staleLocatorWrite = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET backup_target_id = $2")
    );
    expect(staleLocatorWrite).toBeUndefined();
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("SELECT metadata FROM recovery_points")
      && String(sql).includes("FOR UPDATE")
    )).toBe(true);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rclone" }),
      `${pointId}/attempts/${captureAttempt.token}/manifest.json`
    );
    expect(mocks.preserveTrackedRecoveryTemporaryDirectory).not.toHaveBeenCalled();
  });
});
