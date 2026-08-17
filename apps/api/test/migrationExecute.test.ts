import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCloneContainerName } from "../src/services/recoveryRestoreUtils.js";

const query = vi.fn();
const writeAuditEvent = vi.fn();
const getHostForWorker = vi.fn();
const runRecoveryCreate = vi.fn();
const runRecoveryRestore = vi.fn();
const cleanupCompletedRestore = vi.fn();
const retainCompletedRestore = vi.fn();
const retainCompletedRestoreForReconciliation = vi.fn();
const resolveRecoverySourceRestartObligation = vi.fn();
const resolveAppContext = vi.fn();
const getMigrationRecoveryPoint = vi.fn();
const createMigrationRecoveryPoint = vi.fn();
const stopContainersWithRestartOnFailure = vi.fn();
const startContainersOneByOne = vi.fn();
const runSshCommand = vi.fn();
const syncDockerInventory = vi.fn();
const checkImageUpdatesForHost = vi.fn();
const revalidateMigrationPlan = vi.fn();
const migrationIntentsEqual = vi.fn();
const recoveryAppIdentitiesEqual = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/audit.js", () => ({
  writeAuditEvent: (...args: unknown[]) => writeAuditEvent(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/recoveryCapture.js", () => ({
  resolveRecoverySourceRestartObligation: (...args: unknown[]) =>
    resolveRecoverySourceRestartObligation(...args),
  runRecoveryCreate: (...args: unknown[]) => runRecoveryCreate(...args)
}));

vi.mock("../src/services/recoveryRestore.js", () => ({
  RecoveryRestoreCleanupRequiredError:
    class RecoveryRestoreCleanupRequiredError extends Error {
      readonly code =
        "RECOVERY_RESTORE_CLEANUP_REQUIRED";
      constructor(
        message: string,
        readonly cleanup: {
          cleanup: () => Promise<void>;
          retain: () => Promise<void>;
          retainForReconciliation: () => Promise<void>;
        },
        readonly remoteOutcomeUnknown: boolean,
        cause?: unknown
      ) {
        super(message, { cause });
      }
    },
  runRecoveryRestoreWithCleanup: async (...args: unknown[]) => ({
    restore: await runRecoveryRestore(...args),
    cleanup: {
      cleanup: (...cleanupArgs: unknown[]) => cleanupCompletedRestore(...cleanupArgs),
      retain: (...retainArgs: unknown[]) => retainCompletedRestore(...retainArgs),
      retainForReconciliation: (...retainArgs: unknown[]) =>
        retainCompletedRestoreForReconciliation(...retainArgs)
    }
  })
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

vi.mock("../src/services/recoveryCenter.js", () => ({
  createMigrationRecoveryPoint: (...args: unknown[]) => createMigrationRecoveryPoint(...args),
  getMigrationRecoveryPoint: (...args: unknown[]) => getMigrationRecoveryPoint(...args)
}));

vi.mock("../src/services/recoveryContainerControl.js", () => ({
  startContainersOneByOne: (...args: unknown[]) => startContainersOneByOne(...args),
  stopContainersWithRestartOnFailure: (...args: unknown[]) => stopContainersWithRestartOnFailure(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args)
}));

vi.mock("../src/services/docker.js", () => ({
  syncDockerInventory: (...args: unknown[]) => syncDockerInventory(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: (...args: unknown[]) => checkImageUpdatesForHost(...args)
}));

vi.mock("../src/services/migrationPlanning.js", () => ({
  MigrationPlanStaleError: class MigrationPlanStaleError extends Error {},
  revalidateMigrationPlan: (...args: unknown[]) => revalidateMigrationPlan(...args),
  migrationIntentsEqual: (...args: unknown[]) => migrationIntentsEqual(...args),
  recoveryAppIdentitiesEqual: (...args: unknown[]) => recoveryAppIdentitiesEqual(...args)
}));

const sourceHostId = "00000000-0000-4000-8000-000000000001";
const targetHostId = "00000000-0000-4000-8000-000000000002";
const migrationRunId = "00000000-0000-4000-8000-000000000003";
const recoveryPointId = "00000000-0000-4000-8000-000000000004";
const finalRecoveryPointId = "00000000-0000-4000-8000-000000000009";
const projectName = "standalone-restore-00000000";
const restoredName = buildCloneContainerName("web", projectName);

const migrationRow = {
  id: migrationRunId,
  plan_run_id: "00000000-0000-4000-8000-000000000010",
  source_host_id: sourceHostId,
  target_host_id: targetHostId,
  source_app_identity: { kind: "standalone", containerIds: ["source-web"] },
  mode: "execute",
  status: "queued",
  recovery_point_id: recoveryPointId,
  plan: {
    sourceHostId,
    targetHostId,
    sourceAppIdentity: { kind: "standalone", containerIds: ["source-web"] },
    intent: {
      strategy: "clone",
      options: { stopSource: false, remapPorts: true, networkMode: "clone" }
    },
    sourceFingerprint: "a".repeat(64),
    targetFingerprint: "b".repeat(64),
    steps: [],
    warnings: [],
    estimatedArtifacts: 1,
    estimatedVolumes: 0,
    estimatedHostFolders: 0,
    checks: {
      sourceHostAvailable: true,
      targetHostAvailable: true,
      sourceDockerAvailable: true,
      targetDockerAvailable: true,
      sourceComposeAvailable: true,
      targetComposeAvailable: true
    },
    portConflicts: [],
    volumeCollisions: [],
    nameCollisions: [],
    missingNetworks: [],
    networkConflicts: [],
    estimatedDataBytes: null,
    blockingIssues: []
  },
  error: null,
  created_at: new Date("2026-06-15T12:00:00.000Z"),
  started_at: null,
  completed_at: null
};

const recoveryPointDetail = {
  id: recoveryPointId,
  hostId: sourceHostId,
  name: "Migration point",
  appIdentity: { kind: "standalone", containerIds: ["source-web"] },
  triggerKind: "pre_migration",
  status: "completed",
  backupTargetId: null,
  legacyVolumeBackupId: null,
  artifactCount: 1,
  completedArtifactCount: 1,
  totalBytes: null,
  error: null,
  metadata: {},
  lastDrillAt: null,
  lastDrillStatus: null,
  lastDrillError: null,
  lastSuccessfulDrillAt: null,
  createdAt: "2026-06-15T12:00:00.000Z",
  startedAt: "2026-06-15T12:00:00.000Z",
  completedAt: "2026-06-15T12:00:00.000Z",
  artifacts: []
};

function inspectPayload(name: string, running: boolean) {
  return JSON.stringify([{
    Id: name,
    Name: `/${name}`,
    State: { Running: running, Status: running ? "running" : "exited" },
    Config: { Image: "nginx:alpine" },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } }
  }]);
}

async function unexpectedCommand(command: string) {
  return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
}

function isRestartArmSql(sql: unknown) {
  const value = String(sql);
  return value.includes("UPDATE recovery_points")
    && value.includes("migration_run_id = $2")
    && value.includes("sourceRestartResolution");
}

describe("migration execute standalone restore verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupCompletedRestore.mockResolvedValue(undefined);
    resolveRecoverySourceRestartObligation.mockResolvedValue(undefined);

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      return { rows: [] };
    });
    writeAuditEvent.mockResolvedValue(undefined);
    getHostForWorker.mockImplementation(async (hostId: string) => ({
      public: { tags: [], dockerSocketPath: "/var/run/docker.sock" },
      connectionMode: "ssh",
      ssh: { hostId }
    }));
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web"],
      volumeNames: []
    });
    runRecoveryCreate.mockResolvedValue({
      recoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runRecoveryRestore.mockResolvedValue({
      mode: "clone",
      projectName,
      restoredVolumes: 0,
      restoredBindMounts: 0,
      composeRestored: false,
      standaloneContainersRestored: 1,
      restoredContainerNames: [restoredName],
      volumeMap: {},
      bindMap: {},
      portRemap: {}
    });
    getMigrationRecoveryPoint.mockResolvedValue(recoveryPointDetail);
    createMigrationRecoveryPoint.mockResolvedValue({ id: recoveryPointId });
    stopContainersWithRestartOnFailure.mockResolvedValue(["source-web"]);
    startContainersOneByOne.mockResolvedValue(undefined);
    syncDockerInventory.mockResolvedValue({ container: 1, image: 1, network: 1, volume: 0 });
    checkImageUpdatesForHost.mockResolvedValue([]);
    revalidateMigrationPlan.mockResolvedValue(migrationRow.plan);
    migrationIntentsEqual.mockReturnValue(true);
    recoveryAppIdentitiesEqual.mockReturnValue(true);
  });

  it("verifies standalone restores by restored container names instead of compose project", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(result.restore.standaloneContainersRestored).toBe(1);
    expect(runRecoveryCreate).not.toHaveBeenCalled();
    expect(runRecoveryRestore).toHaveBeenCalledWith(targetHostId, expect.objectContaining({ recoveryPointId }));
    expect(cleanupCompletedRestore).not.toHaveBeenCalled();
    expect(syncDockerInventory).toHaveBeenCalledWith(targetHostId);
    expect(result.inventory.synced).toBe(true);
    expect(revalidateMigrationPlan).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: migrationRunId }), {
      refreshSource: true,
      refreshTarget: true
    });
    expect(revalidateMigrationPlan).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: migrationRunId }), {
      refreshSource: false,
      refreshTarget: true
    });
    expect(commands.some((command) => command.includes("docker compose"))).toBe(false);
    expect(commands.some((command) => command.includes(`docker inspect '${restoredName}'`))).toBe(true);
  });

  it("fails closed before capture when worker-side plan revalidation detects drift", async () => {
    revalidateMigrationPlan.mockRejectedValueOnce(new Error("Source or target state changed after planning"));

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Source or target state changed after planning");

    expect(runRecoveryCreate).not.toHaveBeenCalled();
    expect(runRecoveryRestore).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      "UPDATE migration_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
      [migrationRunId, "Source or target state changed after planning"]
    );
  });

  it("rejects a linked recovery point for a different source application during worker revalidation", async () => {
    recoveryAppIdentitiesEqual.mockReturnValue(false);
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("different source application");

    expect(getMigrationRecoveryPoint).toHaveBeenCalledWith(recoveryPointId, migrationRunId);
    expect(runRecoveryRestore).not.toHaveBeenCalled();
  });

  it("fails closed when the queued job intent differs from the reviewed plan", async () => {
    migrationIntentsEqual.mockReturnValue(false);

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Migration job intent does not match its reviewed plan");

    expect(runRecoveryCreate).not.toHaveBeenCalled();
    expect(runRecoveryRestore).not.toHaveBeenCalled();
  });

  it("fails when target deployment verifies but inventory never sees the restored container", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) return { rows: [] };
      return { rows: [] };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true,
      inventoryPollAttempts: 1,
      inventoryPollDelayMs: 0
    })).rejects.toThrow("Target deployed, but inventory did not sync before completion");

    expect(syncDockerInventory).toHaveBeenCalledWith(targetHostId);
    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("inventory did not sync")]
    );
  });

  it("fails compose migrations when restored volumes are not mounted by target containers", async () => {
    getMigrationRecoveryPoint.mockResolvedValue({
      ...recoveryPointDetail,
      artifactCount: 1,
      completedArtifactCount: 1,
      artifacts: [{
        kind: "volume",
        status: "completed",
        error: null,
        metadata: { volumeName: "demoapp_data" },
        storageKey: "volumes/demoapp_data.tar.gz"
      }]
    });
    runRecoveryRestore.mockResolvedValueOnce({
      mode: "clone",
      projectName: "demoapp-restore-00000000",
      restoredVolumes: 1,
      restoredBindMounts: 0,
      composeRestored: true,
      standaloneContainersRestored: 0,
      restoredContainerNames: [],
      volumeMap: { demoapp_data: "demoapp-restore-00000000_data" },
      bindMap: {},
      portRemap: {}
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes("docker compose -p 'demoapp-restore-00000000' ps --format json")) {
        return { code: 0, stdout: JSON.stringify({ State: "running" }), stderr: "" };
      }
      if (command.includes("docker compose -p 'demoapp-restore-00000000' ps -q")) {
        return { code: 0, stdout: "target-web\n", stderr: "" };
      }
      if (command.includes("docker inspect 'target-web'")) {
        return {
          code: 0,
          stdout: JSON.stringify([{ Mounts: [{ Type: "volume", Name: "demoapp-restore-00000000_wrong", Destination: "/app/data" }] }]),
          stderr: ""
        };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Restored compose containers are not using restored volume");

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("demoapp-restore-00000000_data")]
    );
  });

  it("creates a fresh final recovery point for a supplied safe move point", async () => {
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    });

    expect(createMigrationRecoveryPoint).toHaveBeenCalledWith(expect.objectContaining({
      name: `Migration final ${migrationRunId}`,
      stopFirst: true
    }), migrationRunId, { primary: true, executionFence: undefined });
    expect(runRecoveryCreate).toHaveBeenCalledWith(sourceHostId, finalRecoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      deferRestartObligationResolution: true
    });
    expect(runRecoveryRestore).toHaveBeenCalledWith(targetHostId, expect.objectContaining({ recoveryPointId: finalRecoveryPointId }));
    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: true,
        containerIds: ["source-web"],
        resolution: "intentionally_left_stopped"
      },
      undefined
    );
    expect(result.recoveryPointId).toBe(finalRecoveryPointId);
    expect(result.sourceLeftStopped).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    )).toBe(true);
  });

  it("defers worker-bound migration publication to fenced job completion", async () => {
    const operationJobId = "66666666-6666-4666-8666-666666666666";
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });
    const executionFence = {
      jobId: operationJobId,
      attemptCount: 1,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: import("pg").PoolClient) => Promise<T>
      ) => callback({
        query: (...args: Parameters<typeof query>) => query(...args)
      } as unknown as import("pg").PoolClient)
    };

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true,
      executionFence,
      operationJobId
    });

    expect(result).toMatchObject({
      migrationRunId,
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true
    });
    expect(runRecoveryRestore).toHaveBeenCalledWith(
      targetHostId,
      expect.objectContaining({ recoveryPointId: finalRecoveryPointId }),
      executionFence,
      expect.objectContaining({
        operationJobId,
        migrationRunId,
        beforeRemoteMutation: expect.any(Function)
      })
    );
    expect(resolveRecoverySourceRestartObligation).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    )).toBe(false);
    expect(cleanupCompletedRestore).not.toHaveBeenCalled();
    expect(retainCompletedRestore).not.toHaveBeenCalled();
  });

  it.each([
    ["without an execution fence", undefined],
    ["with a different job fence", {
      jobId: "77777777-7777-4777-8777-777777777777",
      attemptCount: 1,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: vi.fn()
    }]
  ])(
    "rejects worker-bound migration publication %s",
    async (_description, executionFence) => {
      const operationJobId = "66666666-6666-4666-8666-666666666666";
      const { runMigrationExecute } = await import("../src/services/migrationExecute.js");

      await expect(runMigrationExecute(sourceHostId, migrationRunId, {
        strategy: "safe_move",
        stopSource: false,
        remapPorts: true,
        operationJobId,
        ...(executionFence ? { executionFence } : {})
      })).rejects.toThrow(
        "A worker-bound migration requires an execution fence for the same operation job"
      );

      expect(query).not.toHaveBeenCalled();
      expect(runRecoveryRestore).not.toHaveBeenCalled();
    }
  );

  it("creates a final stop-first capture for safe moves without an eager source stop", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) {
        return { rows: [{ ...migrationRow, recovery_point_id: null }] };
      }
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    });

    expect(stopContainersWithRestartOnFailure).not.toHaveBeenCalled();
    expect(runRecoveryCreate).toHaveBeenCalledWith(sourceHostId, finalRecoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      deferRestartObligationResolution: true
    });
    expect(runRecoveryRestore).toHaveBeenCalledWith(targetHostId, expect.objectContaining({ recoveryPointId: finalRecoveryPointId }));
    expect(result.sourceLeftStopped).toBe(true);
  });

  it("does online pre-copy before the final stop-first capture for warm moves", async () => {
    const preCopyPointId = "00000000-0000-4000-8000-000000000010";
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) {
        return { rows: [{ ...migrationRow, recovery_point_id: null }] };
      }
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint
      .mockResolvedValueOnce({ id: preCopyPointId })
      .mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate
      .mockResolvedValueOnce({ recoveryPointId: preCopyPointId, sourceLeftStopped: false, stoppedContainerIds: [] })
      .mockResolvedValueOnce({ recoveryPointId: finalRecoveryPointId, sourceLeftStopped: true, stoppedContainerIds: ["source-web"] });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "warm_move",
      stopSource: false,
      remapPorts: true
    });

    expect(runRecoveryCreate).toHaveBeenNthCalledWith(1, sourceHostId, preCopyPointId, { stopFirst: false });
    expect(runRecoveryCreate).toHaveBeenNthCalledWith(2, sourceHostId, finalRecoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false,
      deferRestartObligationResolution: true
    });
    expect(stopContainersWithRestartOnFailure).not.toHaveBeenCalled();
    expect(result.recoveryPointId).toBe(finalRecoveryPointId);
    expect(result.sourceLeftStopped).toBe(true);
  });

  it("restarts source when final move capture fails after stopping it", async () => {
    const captureError = Object.assign(new Error("final capture failed"), {
      sourceStoppedIds: ["source-web"]
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockRejectedValueOnce(captureError);
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("final capture failed; source restarted");

    expect(startContainersOneByOne).toHaveBeenCalledWith(sourceHostId, ["source-web"]);
    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: false,
        containerIds: ["source-web"],
        resolution: "restarted"
      },
      undefined,
      true
    );
    expect(runRecoveryRestore).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, "final capture failed; source restarted"]
    );
  });

  it("restarts capture-reported stopped containers even when the pre-capture inspect saw them stopped", async () => {
    const captureError = Object.assign(new Error("final capture lost lease"), {
      sourceStoppedIds: ["source-web"]
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockRejectedValueOnce(captureError);
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", false), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("final capture lost lease; source restarted");

    expect(startContainersOneByOne).toHaveBeenCalledWith(sourceHostId, ["source-web"]);
    expect(runRecoveryRestore).not.toHaveBeenCalled();
  });

  it("fails before target restore when required host folder capture is incomplete", async () => {
    getMigrationRecoveryPoint.mockResolvedValue({
      ...recoveryPointDetail,
      status: "partial",
      artifactCount: 2,
      completedArtifactCount: 1,
      artifacts: [{
        kind: "host_folder",
        status: "failed",
        error: "tar: /home/docker/DemoApp: Cannot open",
        metadata: { sourcePath: "/home/docker/DemoApp" },
        storageKey: "points/demoapp/host_folder.tar.gz"
      }]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Migration data capture incomplete");

    expect(runRecoveryRestore).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("/home/docker/DemoApp")]
    );
  });

  it("fails when a completed host folder artifact is not restored", async () => {
    getMigrationRecoveryPoint.mockResolvedValue({
      ...recoveryPointDetail,
      artifactCount: 2,
      completedArtifactCount: 2,
      artifacts: [{
        kind: "host_folder",
        status: "completed",
        error: null,
        metadata: { sourcePath: "/home/docker/DemoApp" },
        storageKey: "points/demoapp/host_folder.tar.gz"
      }]
    });
    runRecoveryRestore.mockResolvedValueOnce({
      mode: "clone",
      projectName,
      restoredVolumes: 0,
      restoredBindMounts: 0,
      composeRestored: false,
      standaloneContainersRestored: 1,
      restoredContainerNames: [restoredName],
      volumeMap: {},
      bindMap: {},
      portRemap: {}
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Migration data restore incomplete");

    expect(runRecoveryRestore).toHaveBeenCalled();
    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("expected 0 Docker volume(s) and 1 host folder(s)")]
    );
  });

  it("cleans the completed standalone restore and restarts source after failed move verification", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 1, stdout: "", stderr: "missing target container" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("missing target container; source restarted");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(stopContainersWithRestartOnFailure).not.toHaveBeenCalled();
    expect(startContainersOneByOne).toHaveBeenCalledWith(sourceHostId, ["source-web"]);
    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(commands.some((command) => command.includes(`docker rm --force '${restoredName}'`))).toBe(false);
    expect(commands.some((command) => command.includes("docker compose"))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("source restarted")]
    );
  });

  it("unions successful capture stopped IDs with pre-inspect restart IDs for the completed move obligation", async () => {
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web", "source-sidecar"],
      volumeNames: []
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-sidecar"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes("docker inspect 'source-sidecar'")) {
        return { code: 1, stdout: "", stderr: "transient inspect miss" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    });

    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: true,
        containerIds: ["source-web", "source-sidecar"],
        resolution: "intentionally_left_stopped"
      },
      undefined
    );
    expect(result.sourceLeftStopped).toBe(true);
    expect(startContainersOneByOne).not.toHaveBeenCalled();
  });

  it("restarts the union of inspected and capture-authoritative source IDs after restore validation fails", async () => {
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web", "source-sidecar"],
      volumeNames: []
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-sidecar"]
    });
    getMigrationRecoveryPoint.mockResolvedValue({
      ...recoveryPointDetail,
      artifactCount: 1,
      completedArtifactCount: 1,
      artifacts: [{
        kind: "host_folder",
        status: "completed",
        error: null,
        metadata: { sourcePath: "/srv/demoapp" },
        storageKey: "points/demoapp/host-folder.tar.gz"
      }]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes("docker inspect 'source-sidecar'")) {
        return { code: 1, stdout: "", stderr: "transient inspect miss" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Migration data restore incomplete");

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(startContainersOneByOne).toHaveBeenCalledWith(
      sourceHostId,
      ["source-web", "source-sidecar"]
    );
    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: false,
        containerIds: ["source-web", "source-sidecar"],
        resolution: "restarted"
      },
      undefined,
      true
    );
  });

  it("restarts capture-authoritative source IDs after later inventory confirmation fails", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", false), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true,
      inventoryPollAttempts: 1,
      inventoryPollDelayMs: 0
    })).rejects.toThrow("inventory did not sync");

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(startContainersOneByOne).toHaveBeenCalledWith(sourceHostId, ["source-web"]);
    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: false,
        containerIds: ["source-web"],
        resolution: "restarted"
      },
      undefined,
      true
    );
  });

  it("retains the exact reconciliation evidence when target cleanup only partially succeeds", async () => {
    const cleanupSecret = "cleanup-secret";
    cleanupCompletedRestore.mockRejectedValueOnce(
      new Error(
        `partial removal failed at https://operator:${cleanupSecret}@target.example.test/resource?token=${cleanupSecret} ${
          "detail".repeat(1_000)
        }`
      )
    );
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 1, stdout: "", stderr: "target verification failed" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("target cleanup failed");

    const evidenceWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET error = $2")
    );
    const evidenceMarker = String((evidenceWrite?.[1] as unknown[] | undefined)?.[1]);
    const failureWrite = query.mock.calls.findLast(([sql]) =>
      String(sql).includes("SET status = 'failed'")
    );
    const finalError = String((failureWrite?.[1] as unknown[] | undefined)?.[1]);

    expect(evidenceMarker).toContain("Automatic migration compensation remains armed");
    expect(finalError).toContain(evidenceMarker);
    expect(finalError).toContain("\"targetVerified\":false");
    expect(finalError).toContain(`\"targetContainerNames\":[\"${restoredName}\"]`);
    expect(finalError).not.toContain(cleanupSecret);
    expect(finalError.length).toBeLessThan(20_000);
  });

  it("retains every resource identity and count beyond 100 entries without truncating long paths", async () => {
    const volumeMap = Object.fromEntries(
      Array.from({ length: 125 }, (_, index) => [
        `source-volume-${index}`,
        `restored-volume-${index}`
      ])
    );
    const longBindPath = `/srv/${"long-segment/".repeat(80)}application-data`;
    const bindSecret = "bind-path-secret";
    const credentialBearingBindPath =
      `/srv/cache/https://operator:${bindSecret}@storage.example.test/archive?token=${bindSecret}`;
    runRecoveryRestore.mockResolvedValueOnce({
      mode: "clone",
      projectName: null,
      restoredVolumes: 125,
      restoredBindMounts: 2,
      composeRestored: false,
      standaloneContainersRestored: 1,
      restoredContainerNames: [restoredName],
      volumeMap,
      networkMap: {
        source: "restored-network"
      },
      bindMap: {
        "/srv/source": longBindPath,
        "/srv/credential-source": credentialBearingBindPath
      },
      portRemap: {}
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "clone",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("Migration restore did not produce a target project name");

    const evidenceWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET error = $2")
    );
    const evidenceMarker = String((evidenceWrite?.[1] as unknown[] | undefined)?.[1]);
    const evidence = JSON.parse(
      evidenceMarker.slice(evidenceMarker.indexOf("{"))
    ) as {
      targetVolumeCount: number;
      targetVolumeNames: string[];
      targetNetworkCount: number;
      targetNetworkNames: string[];
      targetBindMountCount: number;
      targetBindMountPaths: string[];
    };

    expect(evidence.targetVolumeCount).toBe(125);
    expect(evidence.targetVolumeNames).toHaveLength(125);
    expect(evidence.targetVolumeNames.at(-1)).toBe("restored-volume-124");
    expect(evidence.targetNetworkCount).toBe(1);
    expect(evidence.targetNetworkNames).toEqual(["restored-network"]);
    expect(evidence.targetBindMountCount).toBe(2);
    expect(evidence.targetBindMountPaths[0]).toBe(longBindPath);
    expect(evidence.targetBindMountPaths[0]?.length).toBeGreaterThan(512);
    expect(JSON.stringify(evidence.targetBindMountPaths)).not.toContain(bindSecret);
  });

  it("blocks source restart and retains exact reconciliation evidence when target cleanup fails", async () => {
    cleanupCompletedRestore.mockRejectedValueOnce(new Error("target volume removal failed"));
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 1, stdout: "", stderr: "target verification failed" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("source remains stopped until target cleanup is reconciled manually");

    const evidenceWrite = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET error = $2")
    );
    const evidenceMarker = String((evidenceWrite?.[1] as unknown[] | undefined)?.[1]);
    const failureWrite = query.mock.calls.findLast(([sql]) =>
      String(sql).includes("SET status = 'failed'")
    );
    const finalError = String((failureWrite?.[1] as unknown[] | undefined)?.[1]);

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    expect(finalError).toContain("target cleanup failed");
    expect(finalError).toContain(evidenceMarker);
    expect(finalError).toContain("source remains stopped until target cleanup is reconciled manually");
    expect(finalError).toContain("\"sourceLeftStopped\":true");
    expect(finalError).toContain(`\"sourceStoppedContainerIds\":[\"source-web\"]`);
    const armCalls = query.mock.calls.filter(([sql]) => isRestartArmSql(sql));
    expect(armCalls).toHaveLength(2);
    const blockedMetadata = JSON.parse(
      String((armCalls.at(-1)?.[1] as unknown[] | undefined)?.[2])
    );
    expect(blockedMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-web"],
      sourceRestartReconciliationState: "blocked_target_cleanup",
      sourceRestartTargetCleanupBlocked: true,
      sourceRestartTargetCleanupError: "target volume removal failed"
    });
    expect(armCalls.every(([sql]) =>
      String(sql).includes("IS DISTINCT FROM 'running'")
    )).toBe(true);
  });

  it("restarts the full authoritative source set when final completion is rejected and the run is still running", async () => {
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web", "source-sidecar"],
      volumeNames: []
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM migration_runs")) return { rows: [{ status: "running" }] };
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("completion transaction rejected");
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-sidecar"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes("docker inspect 'source-sidecar'")) {
        return { code: 1, stdout: "", stderr: "transient inspect miss" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("completion transaction rejected; source restarted");

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(startContainersOneByOne).toHaveBeenCalledWith(
      sourceHostId,
      ["source-web", "source-sidecar"]
    );
    const armCalls = query.mock.calls.filter(([sql]) => isRestartArmSql(sql));
    expect(armCalls).toHaveLength(2);
    const blockedMetadata = JSON.parse(
      String((armCalls[0]?.[1] as unknown[] | undefined)?.[2])
    );
    const pendingMetadata = JSON.parse(
      String((armCalls[1]?.[1] as unknown[] | undefined)?.[2])
    );
    expect(blockedMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-web", "source-sidecar"],
      sourceRestartReconciliationState: "blocked_target_cleanup",
      sourceRestartTargetCleanupBlocked: true
    });
    expect(pendingMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-web", "source-sidecar"],
      restartFailedIds: [],
      sourceRestartReconciliationState: "pending",
      sourceRestartTargetCleanupBlocked: false
    });
    expect(String(armCalls[1]?.[0])).toContain(
      "sourceRestartReconciliationState' = 'blocked_target_cleanup'"
    );
    expect(String(armCalls[1]?.[0])).toContain(
      "sourceRestartTargetCleanupBlocked' = 'true'"
    );
    const blockedCallIndex = query.mock.calls.indexOf(armCalls[0]!);
    const pendingCallIndex = query.mock.calls.indexOf(armCalls[1]!);
    expect(query.mock.invocationCallOrder[blockedCallIndex])
      .toBeLessThan(cleanupCompletedRestore.mock.invocationCallOrder[0]!);
    expect(cleanupCompletedRestore.mock.invocationCallOrder[0])
      .toBeLessThan(query.mock.invocationCallOrder[pendingCallIndex]!);
    expect(query.mock.invocationCallOrder[pendingCallIndex])
      .toBeLessThan(startContainersOneByOne.mock.invocationCallOrder[0]!);
    expect(resolveRecoverySourceRestartObligation).toHaveBeenLastCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: false,
        containerIds: ["source-web", "source-sidecar"],
        resolution: "restarted"
      },
      undefined,
      true
    );
  });

  it("keeps only the unresolved source IDs pending when rollback restarts only part of the source", async () => {
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web", "source-sidecar"],
      volumeNames: []
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM migration_runs")) return { rows: [{ status: "running" }] };
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("completion transaction rejected");
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-sidecar"]
    });
    startContainersOneByOne.mockRejectedValueOnce(Object.assign(
      new Error("source-sidecar remained stopped"),
      { restartFailedIds: ["source-sidecar"] }
    ));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes("docker inspect 'source-sidecar'")) {
        return { code: 1, stdout: "", stderr: "transient inspect miss" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toThrow("rollback failed: source-sidecar remained stopped");

    const armCalls = query.mock.calls.filter(([sql]) => isRestartArmSql(sql));
    expect(armCalls).toHaveLength(3);
    const blockedMetadata = JSON.parse(
      String((armCalls[0]?.[1] as unknown[] | undefined)?.[2])
    );
    const pendingMetadata = JSON.parse(
      String((armCalls[1]?.[1] as unknown[] | undefined)?.[2])
    );
    const unresolvedMetadata = JSON.parse(
      String((armCalls[2]?.[1] as unknown[] | undefined)?.[2])
    );
    expect(blockedMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-web", "source-sidecar"],
      sourceRestartReconciliationState: "blocked_target_cleanup",
      sourceRestartTargetCleanupBlocked: true
    });
    expect(pendingMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-web", "source-sidecar"],
      restartFailedIds: [],
      sourceRestartReconciliationState: "pending",
      sourceRestartTargetCleanupBlocked: false
    });
    expect(unresolvedMetadata).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["source-sidecar"],
      sourceStoppedIds: ["source-sidecar"],
      restartFailedIds: ["source-sidecar"],
      sourceRestartReconciliationState: "pending",
      sourceRestartTargetCleanupBlocked: false
    });
  });

  it("retains both sides when known completion failure cannot durably block restart during cleanup", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM migration_runs")) return { rows: [{ status: "running" }] };
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("completion transaction rejected");
      }
      if (isRestartArmSql(sql)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toMatchObject({
      code: "MIGRATION_COMPENSATION_RECONCILIATION_REQUIRED"
    });

    expect(cleanupCompletedRestore).not.toHaveBeenCalled();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
  });

  it("keeps the source stopped when cleanup succeeds but the blocked-to-pending transition is lost", async () => {
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT status FROM migration_runs")) return { rows: [{ status: "running" }] };
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("completion transaction rejected");
      }
      if (
        isRestartArmSql(sql)
        && Array.isArray(values)
        && typeof values[2] === "string"
        && JSON.parse(values[2]).sourceRestartReconciliationState === "pending"
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toMatchObject({
      code: "MIGRATION_COMPENSATION_RECONCILIATION_REQUIRED"
    });

    expect(cleanupCompletedRestore).toHaveBeenCalledOnce();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    const armCalls = query.mock.calls.filter(([sql]) => isRestartArmSql(sql));
    expect(armCalls).toHaveLength(2);
    expect(JSON.parse(String((armCalls[0]?.[1] as unknown[])?.[2]))).toMatchObject({
      sourceRestartReconciliationState: "blocked_target_cleanup",
      sourceRestartTargetCleanupBlocked: true
    });
    expect(JSON.parse(String((armCalls[1]?.[1] as unknown[])?.[2]))).toMatchObject({
      sourceRestartReconciliationState: "pending",
      sourceRestartTargetCleanupBlocked: false
    });
  });

  it("accepts a committed completion after its database response is lost without deleting the verified target", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM migration_runs")) return { rows: [{ status: "completed" }] };
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("database response lost after commit");
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    const result = await runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    });

    expect(result.sourceLeftStopped).toBe(true);
    expect(cleanupCompletedRestore).not.toHaveBeenCalled();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => isRestartArmSql(sql))).toBe(false);
    expect(resolveRecoverySourceRestartObligation).toHaveBeenCalledWith(
      finalRecoveryPointId,
      {
        sourceLeftStopped: true,
        containerIds: ["source-web"],
        resolution: "intentionally_left_stopped"
      },
      undefined
    );
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE migration_runs SET status = 'failed'")
    )).toBe(false);
  });

  it("retains target and source state with durable evidence when completion status cannot be re-read", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM migration_runs")) {
        throw new Error("database unavailable during reconciliation");
      }
      if (sql.includes("SELECT * FROM migration_runs")) return { rows: [migrationRow] };
      if (sql.includes("FROM resource_snapshots") && sql.includes("kind = 'container'")) {
        return {
          rows: [{
            external_id: restoredName,
            name: restoredName,
            data: { Names: restoredName, State: "running", Labels: {} }
          }]
        };
      }
      if (sql.includes("SET status = 'completed'")) {
        throw new Error("completion response unknown");
      }
      return { rows: [] };
    });
    createMigrationRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
    runRecoveryCreate.mockResolvedValueOnce({
      recoveryPointId: finalRecoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 0, stdout: inspectPayload(restoredName, true), stderr: "" };
      }
      return unexpectedCommand(command);
    });

    const { runMigrationExecute } = await import("../src/services/migrationExecute.js");
    await expect(runMigrationExecute(sourceHostId, migrationRunId, {
      strategy: "safe_move",
      stopSource: false,
      remapPorts: true
    })).rejects.toMatchObject({
      code: "MIGRATION_COMPLETION_RECONCILIATION_REQUIRED",
      evidence: {
        migrationRunId,
        recoveryPointId: finalRecoveryPointId,
        targetHostId,
        targetVerified: true,
        targetProjectName: projectName,
        targetContainerNames: [restoredName],
        sourceLeftStopped: true,
        sourceStoppedContainerIds: ["source-web"]
      }
    });

    expect(cleanupCompletedRestore).not.toHaveBeenCalled();
    expect(startContainersOneByOne).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => isRestartArmSql(sql))).toBe(false);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE migration_runs SET status = 'failed'")
    )).toBe(false);
    const evidenceWrites = query.mock.calls.filter(([sql]) =>
      String(sql).includes("Automatic migration compensation remains armed")
      || String(sql).includes("SET error = $2")
    );
    const lastEvidenceValues = evidenceWrites.at(-1)?.[1] as unknown[] | undefined;
    expect(String(lastEvidenceValues?.[1])).toContain("\"targetVerified\":true");
    expect(String(lastEvidenceValues?.[1])).toContain(`\"targetContainerNames\":[\"${restoredName}\"]`);
  });
});
