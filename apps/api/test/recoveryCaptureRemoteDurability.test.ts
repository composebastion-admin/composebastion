import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionFence } from "../src/services/jobs.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadWorkerBackupTarget: vi.fn(),
  uploadRemoteArtifact: vi.fn(),
  headRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  deleteRemoteArtifact: vi.fn(),
  hashFile: vi.fn(),
  safeRecoveryPointFile: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: vi.fn()
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget: (...args: unknown[]) => mocks.loadWorkerBackupTarget(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  uploadRemoteArtifact: (...args: unknown[]) => mocks.uploadRemoteArtifact(...args),
  headRemoteArtifact: (...args: unknown[]) => mocks.headRemoteArtifact(...args),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => mocks.downloadRemoteArtifactAtomically(...args),
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args)
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  hashFile: (...args: unknown[]) => mocks.hashFile(...args),
  safeRecoveryPointFile: (...args: unknown[]) => mocks.safeRecoveryPointFile(...args),
  writeRecoveryPointFile: vi.fn()
}));

const pointId = "00000000-0000-4000-8000-000000000201";
const targetId = "00000000-0000-4000-8000-000000000202";
const artifactId = "00000000-0000-4000-8000-000000000203";
const now = new Date("2026-07-30T10:00:00.000Z");
const goodBytes = Buffer.from("verified-body");
const corruptSameSizeBytes = Buffer.from("corrupt-body!");

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
          configText: "[composebastion]\ntype = smb\n"
        }
      })
  };
}

describe("recovery capture remote durability", () => {
  let tempDirectory: string;
  let localPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "recovery-remote-durability-"));
    localPath = path.join(tempDirectory, pointId, "manifest.json");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, goodBytes);

    mocks.safeRecoveryPointFile.mockImplementation((recoveryPointId: string, storageKey: string) =>
      path.join(tempDirectory, recoveryPointId, storageKey)
    );
    mocks.hashFile.mockImplementation(async (filePath: string) => sha256(await readFile(filePath)));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
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
  });

  it.each(["s3", "rclone"] as const)(
    "rejects a same-size corrupt %s object even when HEAD echoes the expected checksum",
    async (kind) => {
      mocks.loadWorkerBackupTarget.mockResolvedValue(target(kind));
      mocks.downloadRemoteArtifactAtomically.mockImplementation(
        async (_target: unknown, _objectKey: string, destination: string) => {
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, corruptSameSizeBytes);
        }
      );

      const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
      await expect(uploadRecoveryArtifactsToRemote(pointId, targetId)).resolves.toBe(1);

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

  it("keeps a verified locator successful when cache bookkeeping loses its lease after rm", async () => {
    mocks.loadWorkerBackupTarget.mockResolvedValue(target("s3"));
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [artifactRow] };
      const metadata = typeof values?.[1] === "string" && values[1].startsWith("{")
        ? JSON.parse(values[1])
        : null;
      if (metadata?.localCacheRemoved === true) throw new Error("job lease lost during cleanup bookkeeping");
      return { rows: [] };
    });

    const { uploadRecoveryArtifactsToRemote } = await import("../src/services/recoveryCapture.js");
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId)).resolves.toBe(0);

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
    await expect(uploadRecoveryArtifactsToRemote(pointId, targetId, executionFence)).resolves.toBe(1);

    expect(await readFile(localPath)).toEqual(goodBytes);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("orphanRemoteObjectKey"))).toBe(false);
  });
});
