import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionFence } from "../src/services/jobs.js";

const query = vi.fn();
const getHostForWorker = vi.fn();
const resolveAppContext = vi.fn();
const stopContainersWithRestartOnFailure = vi.fn();
const startContainersOneByOne = vi.fn();
const hashFile = vi.fn();
const enforceScheduledRecoveryRetention = vi.fn();
const loadWorkerBackupTarget = vi.fn();
const runDocker = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (callback: (client: { query: (...args: unknown[]) => unknown }) => unknown) => callback({
    query: (...args: unknown[]) => query(...args)
  })
}));

vi.mock("../src/services/demo.js", () => ({
  isDemoHost: () => true
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  isComposeApp: () => false,
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

vi.mock("../src/services/recoveryContainerControl.js", () => ({
  startContainersOneByOne: (...args: unknown[]) => startContainersOneByOne(...args),
  stopContainersWithRestartOnFailure: (...args: unknown[]) => stopContainersWithRestartOnFailure(...args)
}));

vi.mock("../src/services/recoveryRetention.js", () => ({
  enforceScheduledRecoveryRetention: (...args: unknown[]) => enforceScheduledRecoveryRetention(...args)
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  loadWorkerBackupTarget: (...args: unknown[]) => loadWorkerBackupTarget(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  deleteRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  headRemoteArtifact: vi.fn(),
  uploadRemoteArtifact: vi.fn()
}));

vi.mock("../src/services/recoveryRemoteOrphans.js", () => ({
  recordRemoteArtifactOrphan: vi.fn()
}));

vi.mock("../src/services/recoveryTemporaryStorage.js", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  return {
    createRecoveryTemporaryDirectory: vi.fn(async (
      recoveryPointId: string,
      namespace: string,
      prefix: string
    ) => {
      const directory = `/tmp/${recoveryPointId}/${namespace}/${prefix}-unit`;
      await mkdir(directory, { recursive: true });
      return directory;
    }),
    removeTrackedRecoveryTemporaryDirectory: vi.fn(async (directory: string) => {
      await rm(directory, { recursive: true, force: true });
    })
  };
});

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  hashFile: (...args: unknown[]) => hashFile(...args),
  recoveryPointsRootDir: () => "/tmp",
  readRecoveryPointFile: vi.fn(),
  safeRecoveryPointFile: vi.fn((recoveryPointId: string, storageKey: string) => `/tmp/${recoveryPointId}/${storageKey}`)
}));

vi.mock("../src/services/recoveryS3.js", () => ({
  buildS3ObjectKey: vi.fn(),
  createS3Client: vi.fn(),
  headRecoveryArtifactOnS3: vi.fn(),
  resolveRecoveryPointStatus: ({
    localCompleted,
    localFailed,
    remoteUploadFailures
  }: {
    localCompleted: number;
    localFailed: number;
    remoteUploadFailures: number;
  }) => {
    if (remoteUploadFailures > 0) return { status: localCompleted > 0 ? "partial" : "failed", error: "Remote upload failed" };
    if (localFailed > 0) return { status: localCompleted > 0 ? "partial" : "failed", error: "Artifact capture failed" };
    return { status: "completed", error: null };
  },
  uploadRecoveryArtifactToS3: vi.fn()
}));

vi.mock("../src/services/docker.js", () => ({
  runDocker: (...args: unknown[]) => runDocker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: vi.fn(),
  streamSshCommandToFile: vi.fn()
}));

vi.mock("../src/services/recoveryRestoreUtils.js", () => ({
  buildBindMountCaptureCommand: vi.fn()
}));

const hostId = "00000000-0000-4000-8000-000000000050";
const recoveryPointId = "00000000-0000-4000-8000-000000000051";
const now = new Date("2026-06-15T12:00:00.000Z");
let backupTargetId: string | null = null;
let resourceMounts: Array<Record<string, unknown>> = [];
let activeCaptureToken = "";

const pointRow = {
  id: recoveryPointId,
  host_id: hostId,
  name: "Point",
  app_identity: { kind: "standalone", containerIds: ["source-web"] },
  trigger_kind: "manual",
  status: "completed",
  backup_target_id: null,
  legacy_volume_backup_id: null,
  artifact_count: 1,
  completed_artifact_count: 1,
  total_bytes: null,
  error: null,
  metadata: { stopFirst: true },
  created_at: now,
  started_at: now,
  completed_at: now
};

const metadataArtifactRow = {
  id: "00000000-0000-4000-8000-000000000052",
  recovery_point_id: recoveryPointId,
  kind: "metadata",
  backup_target_id: null,
  storage_key: "manifest.json",
  size_bytes: 12,
  checksum: "sha256:manifest",
  status: "completed",
  error: null,
  metadata: { manifestVersion: 1 },
  created_at: now,
  completed_at: now
};

function installQueryMock() {
  query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM resource_snapshots")) {
      return {
        rows: [{
          data: {
            Names: "source-web",
            State: "running",
            Image: "nginx:alpine",
            Labels: {},
            Mounts: resourceMounts
          }
        }]
      };
    }
    if (sql === "SELECT * FROM recovery_points WHERE id = $1") {
      return { rows: [{ ...pointRow, backup_target_id: backupTargetId }] };
    }
    if (sql.includes("SET status = 'running'") && typeof values?.[1] === "string") {
      activeCaptureToken = JSON.parse(values[1]).captureAttemptToken;
      return { rows: [{ id: recoveryPointId }], rowCount: 1 };
    }
    if (sql.includes("SELECT metadata FROM recovery_points")) {
      return {
        rows: [{ metadata: { captureAttemptToken: activeCaptureToken } }],
        rowCount: 1
      };
    }
    if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow] };
    if (sql.includes("SELECT status FROM recovery_artifacts")) return { rows: [{ status: "completed" }] };
    if (sql.includes("SELECT COALESCE(SUM(size_bytes)")) return { rows: [{ total: 12 }] };
    return { rows: [] };
  });
}

describe("runRecoveryCreate stop-first restart behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backupTargetId = null;
    resourceMounts = [];
    activeCaptureToken = "";
    hashFile.mockResolvedValue("sha256:attempt");
    runDocker.mockResolvedValue({ code: 0, stdout: "Linux", stderr: "" });
    installQueryMock();
    getHostForWorker.mockResolvedValue({
      public: {
        tags: ["demo"],
        dockerVersion: "29.0.0",
        composeVersion: "2.34.0",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: { hostname: "host", username: "root", port: 22 }
    });
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      workingDir: null,
      composePath: null,
      composeYaml: null,
      env: null,
      containerIds: ["source-web"],
      volumeNames: []
    });
    stopContainersWithRestartOnFailure.mockResolvedValue(undefined);
    startContainersOneByOne.mockResolvedValue(undefined);
    enforceScheduledRecoveryRetention.mockResolvedValue({ deletedIds: [], failures: [] });
  });

  it("restarts stopped containers by default after a stop-first capture", async () => {
    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    const result = await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: true });

    expect(stopContainersWithRestartOnFailure).toHaveBeenCalledWith(hostId, ["source-web"], ["source-web"]);
    expect(startContainersOneByOne).toHaveBeenCalledWith(hostId, ["source-web"]);
    const pendingWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("metadata = metadata || $2::jsonb")
      && Array.isArray(values)
      && values[0] === recoveryPointId
      && JSON.parse(String(values[1])).sourceRestartPending === true
    );
    expect(pendingWrite).toBeDefined();
    expect(query.mock.invocationCallOrder[query.mock.calls.indexOf(pendingWrite!)])
      .toBeLessThan(stopContainersWithRestartOnFailure.mock.invocationCallOrder[0]!);
    const resolvedWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("- 'sourceRestartReconciliationToken'")
      && Array.isArray(values)
      && values[0] === recoveryPointId
      && JSON.parse(String(values[1])).sourceRestartResolution === "restarted"
    );
    expect(JSON.parse(String(resolvedWrite?.[1]?.[1]))).toMatchObject({
      sourceRestartPending: false,
      sourceLeftStopped: false,
      sourceRestartResolution: "restarted"
    });
    expect(result).toMatchObject({
      recoveryPointId,
      captureMode: "stop-first",
      sourceLeftStopped: false,
      stoppedContainerIds: []
    });
  });

  it("does not begin capture after a concurrent deletion claim wins", async () => {
    const originalImplementation = query.getMockImplementation();
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SET status = 'running'")) {
        return { rows: [], rowCount: 0 };
      }
      return originalImplementation?.(sql, values);
    });

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, { stopFirst: true }))
      .rejects.toMatchObject({
        statusCode: 409,
        message: "Recovery point is being deleted"
      });

    expect(resolveAppContext).not.toHaveBeenCalled();
    expect(stopContainersWithRestartOnFailure).not.toHaveBeenCalled();
  });

  it("marks a durable capture partial and fails the worker result when source restart fails", async () => {
    resolveAppContext.mockResolvedValueOnce({
      label: "Standalone",
      projectName: null,
      stackId: null,
      workingDir: null,
      composePath: null,
      composeYaml: null,
      env: null,
      containerIds: ["source-web", "source-worker", "source-cache"],
      volumeNames: []
    });
    startContainersOneByOne.mockRejectedValueOnce(Object.assign(
      new Error("restart failed for source-web and source-cache"),
      { restartFailedIds: ["source-web", "source-cache"] }
    ));
    const fencedQueries: Array<{ sql: string; values: unknown[] }> = [];
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          fencedQueries.push({ sql, values });
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      executionFence
    })).rejects.toMatchObject({
      message: "restart failed for source-web and source-cache",
      restartFailedIds: ["source-web", "source-cache"],
      sourceStoppedIds: ["source-web", "source-cache"]
    });

    expect(startContainersOneByOne).toHaveBeenCalledWith(
      hostId,
      ["source-web", "source-worker", "source-cache"]
    );
    const restartFailureWrite = fencedQueries.find(({ sql }) =>
      sql.includes("SET status = CASE")
      && sql.includes("metadata = metadata || $3::jsonb")
    );
    expect(restartFailureWrite?.sql).toContain("SET status = CASE WHEN status IN ('completed', 'partial') THEN 'partial' ELSE status END");
    expect(restartFailureWrite?.values.slice(0, 2)).toEqual([
      recoveryPointId,
      "Restart failed: restart failed for source-web and source-cache"
    ]);
    expect(JSON.parse(String(restartFailureWrite?.values[2]))).toEqual({
      restartFailure: "restart failed for source-web and source-cache",
      restartFailedIds: ["source-web", "source-cache"],
      sourceLeftStopped: true,
      sourceStoppedIds: ["source-web", "source-cache"]
    });
  });

  it("leaves source stopped and records metadata when restartAfterStopFirst is false", async () => {
    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    const result = await runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false
    });

    expect(stopContainersWithRestartOnFailure).toHaveBeenCalledWith(hostId, ["source-web"], ["source-web"]);
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    const intentionallyStoppedWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("- 'sourceRestartReconciliationToken'")
      && Array.isArray(values)
      && values[0] === recoveryPointId
      && JSON.parse(String(values[1])).sourceRestartResolution === "intentionally_left_stopped"
    );
    expect(JSON.parse(String(intentionallyStoppedWrite?.[1]?.[1]))).toMatchObject({
      sourceRestartPending: false,
      sourceLeftStopped: true,
      sourceStoppedIds: ["source-web"],
      stoppedContainerIds: ["source-web"],
      sourceRestartResolution: "intentionally_left_stopped"
    });
    expect(result).toMatchObject({
      recoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
  });

  it("keeps the restart obligation pending when an enclosing migration owns final resolution", async () => {
    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    const result = await runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      deferRestartObligationResolution: true
    });

    expect(result).toMatchObject({
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    const pendingWrite = query.mock.calls.find(([_sql, values]) =>
      Array.isArray(values)
      && values[0] === recoveryPointId
      && typeof values[1] === "string"
      && JSON.parse(values[1]).sourceRestartPending === true
    );
    expect(pendingWrite).toBeDefined();
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes("- 'sourceRestartReconciliationToken'")
      && Array.isArray(values)
      && values[0] === recoveryPointId
    )).toBe(false);
  });

  it("exposes stopped source ids when capture fails and restartAfterStopFirst is false", async () => {
    hashFile.mockRejectedValueOnce(new Error("manifest write failed"));

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    try {
      await runRecoveryCreate(hostId, recoveryPointId, {
        stopFirst: true,
        restartAfterStopFirst: false
      });
      throw new Error("Expected capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { sourceStoppedIds?: string[] }).message).toBe("manifest write failed");
      expect((error as Error & { sourceStoppedIds?: string[] }).sourceStoppedIds).toEqual(["source-web"]);
    }

    expect(startContainersOneByOne).not.toHaveBeenCalled();
  });

  it("preserves stopped source ids when fenced failure finalization loses the lease", async () => {
    hashFile.mockRejectedValueOnce(new Error("manifest write failed"));
    const leaseLost = new Error("job lease lost");
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SET status = 'failed'")) throw leaseLost;
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      executionFence
    })).rejects.toMatchObject({
      message: "job lease lost",
      sourceStoppedIds: ["source-web"]
    });

    expect(stopContainersWithRestartOnFailure).toHaveBeenCalledWith(hostId, ["source-web"], ["source-web"]);
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    const durableSafetyWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("metadata = metadata || $3::jsonb")
      && Array.isArray(values)
      && values[0] === recoveryPointId
      && String(values[1]).includes("manifest write failed")
    );
    expect(JSON.parse(String(durableSafetyWrite?.[1]?.[2]))).toEqual({
      sourceLeftStopped: true,
      sourceStoppedIds: ["source-web"],
      restartFailedIds: []
    });
    expect(String(durableSafetyWrite?.[0])).toContain("metadata->>'captureAttemptToken' = $4");
    expect(durableSafetyWrite?.[1]?.[3]).toEqual(expect.any(String));
  });

  it("does not let a stale failure fallback downgrade a newer completed capture", async () => {
    hashFile.mockRejectedValueOnce(new Error("manifest write failed"));
    const originalImplementation = query.getMockImplementation();
    const durableState = {
      status: "queued",
      captureAttemptToken: "",
      sourceRestartPending: false,
      sourceLeftStopped: false
    };
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SET status = 'running'")) {
        durableState.status = "running";
        durableState.captureAttemptToken = String(
          JSON.parse(String(values[1])).captureAttemptToken
        );
        return { rows: [{ id: recoveryPointId }], rowCount: 1 };
      }
      if (sql.includes("sourceRestartPending") && typeof values[1] === "string") {
        const metadata = JSON.parse(values[1]);
        if (metadata.sourceRestartPending === true) {
          durableState.sourceRestartPending = true;
          durableState.sourceLeftStopped = true;
        }
      }
      if (sql.includes("SET status = 'failed'")) {
        if (values[3] === durableState.captureAttemptToken) {
          durableState.status = "failed";
          durableState.sourceLeftStopped = true;
          return { rows: [{ id: recoveryPointId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return originalImplementation?.(sql, values);
    });
    const leaseLost = new Error("stale capture lease lost");
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (
        callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>
      ) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SET status = 'failed'")) {
            durableState.status = "completed";
            durableState.captureAttemptToken = "newer-completed-attempt";
            durableState.sourceRestartPending = false;
            durableState.sourceLeftStopped = false;
            throw leaseLost;
          }
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      executionFence
    })).rejects.toMatchObject({
      message: "stale capture lease lost",
      sourceStoppedIds: ["source-web"]
    });

    expect(durableState).toEqual({
      status: "completed",
      captureAttemptToken: "newer-completed-attempt",
      sourceRestartPending: false,
      sourceLeftStopped: false
    });
    const staleFallback = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'failed'")
    );
    expect(String(staleFallback?.[0])).toContain("metadata->>'captureAttemptToken' = $4");
    expect(staleFallback?.[1]?.[3]).not.toBe(durableState.captureAttemptToken);
  });

  it("persists exact restart failures outside an expired lease before reporting worker loss", async () => {
    startContainersOneByOne.mockRejectedValueOnce(Object.assign(
      new Error("restart failed for source-web"),
      { restartFailedIds: ["source-web"] }
    ));
    const leaseLost = new Error("job lease lost during restart persistence");
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (
        callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>
      ) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SET status = CASE")) throw leaseLost;
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      executionFence
    })).rejects.toMatchObject({
      message: "job lease lost during restart persistence",
      restartFailedIds: ["source-web"],
      sourceStoppedIds: ["source-web"]
    });

    const durableRestartWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("SET status = CASE")
      && Array.isArray(values)
      && values[0] === recoveryPointId
    );
    expect(durableRestartWrite?.[1]?.[1]).toBe("Restart failed: restart failed for source-web");
    expect(JSON.parse(String(durableRestartWrite?.[1]?.[2]))).toEqual({
      restartFailure: "restart failed for source-web",
      restartFailedIds: ["source-web"],
      sourceLeftStopped: true,
      sourceStoppedIds: ["source-web"]
    });
    expect(String(durableRestartWrite?.[0])).toContain("metadata->>'captureAttemptToken' = $4");
    expect(durableRestartWrite?.[1]?.[3]).toEqual(expect.any(String));
  });

  it("does not let a stale restart-failure fallback make a newer completion partial", async () => {
    startContainersOneByOne.mockRejectedValueOnce(Object.assign(
      new Error("restart failed for source-web"),
      { restartFailedIds: ["source-web"] }
    ));
    const originalImplementation = query.getMockImplementation();
    const durableState = {
      status: "queued",
      captureAttemptToken: "",
      sourceRestartPending: false,
      sourceLeftStopped: false,
      restartFailedIds: [] as string[]
    };
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SET status = 'running'")) {
        durableState.status = "running";
        durableState.captureAttemptToken = String(
          JSON.parse(String(values[1])).captureAttemptToken
        );
        return { rows: [{ id: recoveryPointId }], rowCount: 1 };
      }
      if (sql.includes("SET status = CASE")) {
        if (values[3] === durableState.captureAttemptToken) {
          durableState.status = "partial";
          durableState.sourceLeftStopped = true;
          durableState.restartFailedIds = ["source-web"];
          return { rows: [{ id: recoveryPointId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return originalImplementation?.(sql, values);
    });
    const leaseLost = new Error("stale restart writer lost its lease");
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (
        callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>
      ) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (sql.includes("SET status = CASE")) {
            durableState.status = "completed";
            durableState.captureAttemptToken = "newer-completed-attempt";
            durableState.sourceRestartPending = false;
            durableState.sourceLeftStopped = false;
            durableState.restartFailedIds = [];
            throw leaseLost;
          }
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      executionFence
    })).rejects.toMatchObject({
      message: "stale restart writer lost its lease",
      restartFailedIds: ["source-web"],
      sourceStoppedIds: ["source-web"]
    });

    expect(durableState).toEqual({
      status: "completed",
      captureAttemptToken: "newer-completed-attempt",
      sourceRestartPending: false,
      sourceLeftStopped: false,
      restartFailedIds: []
    });
    const staleFallback = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = CASE")
    );
    expect(String(staleFallback?.[0])).toContain("metadata->>'captureAttemptToken' = $4");
    expect(staleFallback?.[1]?.[3]).not.toBe(durableState.captureAttemptToken);
  });

  it("does not let stale restart-resolution fallback change a newer attempt's restart state", async () => {
    const originalImplementation = query.getMockImplementation();
    const durableState = {
      status: "queued",
      captureAttemptToken: "",
      sourceRestartPending: false,
      sourceLeftStopped: false,
      sourceRestartResolution: null as string | null
    };
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SET status = 'running'")) {
        durableState.status = "running";
        durableState.captureAttemptToken = String(
          JSON.parse(String(values[1])).captureAttemptToken
        );
        return { rows: [{ id: recoveryPointId }], rowCount: 1 };
      }
      if (
        sql.includes("- 'sourceRestartReconciliationToken'")
        && typeof values[1] === "string"
      ) {
        if (values[2] === durableState.captureAttemptToken) {
          const metadata = JSON.parse(values[1]);
          durableState.sourceRestartPending = metadata.sourceRestartPending;
          durableState.sourceLeftStopped = metadata.sourceLeftStopped;
          durableState.sourceRestartResolution = metadata.sourceRestartResolution;
          return { rows: [{ id: recoveryPointId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return originalImplementation?.(sql, values);
    });
    const leaseLost = new Error("stale restart resolver lost its lease");
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (
        callback: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>
      ) => callback({
        query: async (sql: string, values: unknown[] = []) => {
          if (
            sql.includes("- 'sourceRestartReconciliationToken'")
            && typeof values[1] === "string"
            && JSON.parse(values[1]).sourceRestartResolution === "restarted"
          ) {
            durableState.status = "completed";
            durableState.captureAttemptToken = "newer-completed-attempt";
            durableState.sourceRestartPending = false;
            durableState.sourceLeftStopped = false;
            durableState.sourceRestartResolution = "intentionally_left_stopped";
            throw leaseLost;
          }
          return query(sql, values);
        }
      }))
    } as unknown as JobExecutionFence;

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      executionFence
    })).rejects.toBe(leaseLost);

    expect(durableState).toEqual({
      status: "completed",
      captureAttemptToken: "newer-completed-attempt",
      sourceRestartPending: false,
      sourceLeftStopped: false,
      sourceRestartResolution: "intentionally_left_stopped"
    });
    const staleFallback = query.mock.calls.find(([sql]) =>
      String(sql).includes("- 'sourceRestartReconciliationToken'")
      && String(sql).includes("captureAttemptToken")
    );
    expect(String(staleFallback?.[0])).toContain("metadata->>'captureAttemptToken' = $3");
    expect(staleFallback?.[1]?.[2]).not.toBe(durableState.captureAttemptToken);
  });

  it("exposes source ids when the stop phase reports failed partial restarts", async () => {
    stopContainersWithRestartOnFailure.mockRejectedValueOnce(Object.assign(
      new Error("stop failed; restart failed for source-web: start failed"),
      { restartFailedIds: ["source-web"] }
    ));

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await expect(runRecoveryCreate(hostId, recoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false
    })).rejects.toMatchObject({
      message: "stop failed; restart failed for source-web: start failed",
      sourceStoppedIds: ["source-web"]
    });

    expect(hashFile).not.toHaveBeenCalled();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
  });

  it("plans the compose working directory as a host-folder artifact", async () => {
    resolveAppContext.mockResolvedValueOnce({
      label: "DemoApp",
      projectName: "demoapp",
      stackId: null,
      workingDir: "/home/docker/DemoApp",
      composePath: "docker-compose.release.yml",
      composeYaml: "services:\n  demoapp:\n    image: ghcr.io/composebastion-admin/demo-app:beta\n",
      env: null,
      containerIds: ["source-web"],
      volumeNames: []
    });

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: false });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO recovery_artifacts"),
      expect.arrayContaining([
        expect.any(String),
        recoveryPointId,
        "host_folder",
        "host_folder/home_docker_DemoApp",
        expect.objectContaining({
          sourcePath: "/home/docker/DemoApp",
          role: "compose_working_dir",
          restorePath: "/home/docker/DemoApp"
        })
      ])
    );
  });

  it("does not duplicate a relative bind reported through a Docker Desktop path alias", async () => {
    const workingDir = "/tmp/composebastion-acceptance/compose-workload";
    resourceMounts = [{
      Type: "bind",
      Source: "/host_mnt/private/tmp/composebastion-acceptance/compose-workload/relative-data",
      Destination: "/relative-data",
      RW: true
    }];
    resolveAppContext.mockResolvedValueOnce({
      label: "DemoApp",
      projectName: "demoapp",
      stackId: null,
      workingDir,
      composePath: "compose.yml",
      composeYaml: "services:\n  demoapp:\n    image: alpine\n    volumes:\n      - ./relative-data:/relative-data\n",
      env: null,
      containerIds: ["source-web"],
      volumeNames: []
    });
    runDocker.mockResolvedValue({ code: 0, stdout: "Docker Desktop", stderr: "" });

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: false });

    const plannedHostFolders = query.mock.calls
      .filter(([sql, values]) =>
        String(sql).includes("INSERT INTO recovery_artifacts")
        && Array.isArray(values)
        && values[2] === "host_folder"
      )
      .map(([, values]) => (values as unknown[])[4] as Record<string, unknown>);
    expect(plannedHostFolders).toEqual([
      expect.objectContaining({
        sourcePath: workingDir,
        role: "compose_working_dir"
      })
    ]);
  });

  it("keeps a distinct Linux /host_mnt bind as a separate recovery artifact", async () => {
    const workingDir = "/tmp/composebastion-acceptance/compose-workload";
    const linuxBind = "/host_mnt/private/tmp/composebastion-acceptance/compose-workload/relative-data";
    resourceMounts = [{
      Type: "bind",
      Source: linuxBind,
      Destination: "/relative-data",
      RW: true
    }];
    resolveAppContext.mockResolvedValueOnce({
      label: "DemoApp",
      projectName: "demoapp",
      stackId: null,
      workingDir,
      composePath: "compose.yml",
      composeYaml: "services:\n  demoapp:\n    image: alpine\n",
      env: null,
      containerIds: ["source-web"],
      volumeNames: []
    });
    runDocker.mockResolvedValue({ code: 0, stdout: "Ubuntu 24.04.2 LTS", stderr: "" });

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: false });

    const plannedSources = query.mock.calls
      .filter(([sql, values]) =>
        String(sql).includes("INSERT INTO recovery_artifacts")
        && Array.isArray(values)
        && values[2] === "host_folder"
      )
      .map(([, values]) => String(((values as unknown[])[4] as Record<string, unknown>).sourcePath));
    expect(plannedSources).toEqual([workingDir, linuxBind]);
  });

  it.each([
    {
      label: "missing",
      configure: () => loadWorkerBackupTarget.mockRejectedValue(new Error("Backup target not found"))
    },
    {
      label: "disabled",
      configure: () => loadWorkerBackupTarget.mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000060",
        name: "Disabled vault",
        kind: "s3",
        enabled: false,
        localCachePolicy: "keep",
        s3: { config: {}, credentials: {} }
      })
    },
    {
      label: "unsupported",
      configure: () => loadWorkerBackupTarget.mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000060",
        name: "Incomplete vault",
        kind: "rclone",
        enabled: true,
        localCachePolicy: "remote_only",
        rclone: null
      })
    }
  ])("keeps local artifacts completed and makes the point partial when its target is $label", async ({ configure }) => {
    backupTargetId = "00000000-0000-4000-8000-000000000060";
    configure();

    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: false });

    const remoteFailureWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("UPDATE recovery_artifacts")
      && Array.isArray(values)
      && typeof values[2] === "string"
      && values[2].includes("remoteUploadError")
    );
    expect(remoteFailureWrite).toBeDefined();
    expect(String(remoteFailureWrite?.[0])).not.toContain("SET status =");
    const finalPointWrite = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("SET status = $2")
      && Array.isArray(values)
      && values[1] === "partial"
    );
    expect(finalPointWrite).toBeDefined();
  });
});
