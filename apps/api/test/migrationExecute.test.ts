import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCloneContainerName } from "../src/services/recoveryRestoreUtils.js";

const query = vi.fn();
const writeAuditEvent = vi.fn();
const getHostForWorker = vi.fn();
const runRecoveryCreate = vi.fn();
const runRecoveryRestore = vi.fn();
const resolveAppContext = vi.fn();
const getRecoveryPoint = vi.fn();
const createRecoveryPoint = vi.fn();
const stopContainersWithRestartOnFailure = vi.fn();
const startContainersOneByOne = vi.fn();
const runSshCommand = vi.fn();
const syncDockerInventory = vi.fn();
const checkImageUpdatesForHost = vi.fn();

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
  runRecoveryCreate: (...args: unknown[]) => runRecoveryCreate(...args)
}));

vi.mock("../src/services/recoveryRestore.js", () => ({
  runRecoveryRestore: (...args: unknown[]) => runRecoveryRestore(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

vi.mock("../src/services/recoveryCenter.js", () => ({
  createRecoveryPoint: (...args: unknown[]) => createRecoveryPoint(...args),
  getRecoveryPoint: (...args: unknown[]) => getRecoveryPoint(...args)
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

const sourceHostId = "00000000-0000-4000-8000-000000000001";
const targetHostId = "00000000-0000-4000-8000-000000000002";
const migrationRunId = "00000000-0000-4000-8000-000000000003";
const recoveryPointId = "00000000-0000-4000-8000-000000000004";
const finalRecoveryPointId = "00000000-0000-4000-8000-000000000009";
const projectName = "standalone-restore-00000000";
const restoredName = buildCloneContainerName("web", projectName);

const migrationRow = {
  id: migrationRunId,
  source_host_id: sourceHostId,
  target_host_id: targetHostId,
  source_app_identity: { kind: "standalone", containerIds: ["source-web"] },
  mode: "execute",
  status: "queued",
  recovery_point_id: recoveryPointId,
  plan: null,
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

describe("migration execute standalone restore verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    getRecoveryPoint.mockResolvedValue(recoveryPointDetail);
    createRecoveryPoint.mockResolvedValue({ id: recoveryPointId });
    stopContainersWithRestartOnFailure.mockResolvedValue(["source-web"]);
    startContainersOneByOne.mockResolvedValue(undefined);
    syncDockerInventory.mockResolvedValue({ container: 1, image: 1, network: 1, volume: 0 });
    checkImageUpdatesForHost.mockResolvedValue([]);
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
    expect(syncDockerInventory).toHaveBeenCalledWith(targetHostId);
    expect(result.inventory.synced).toBe(true);
    expect(commands.some((command) => command.includes("docker compose"))).toBe(false);
    expect(commands.some((command) => command.includes(`docker inspect '${restoredName}'`))).toBe(true);
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("inventory did not sync")]
    );
  });

  it("fails compose migrations when restored volumes are not mounted by target containers", async () => {
    getRecoveryPoint.mockResolvedValue({
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

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("demoapp-restore-00000000_data")]
    );
  });

  it("creates a fresh final recovery point for a supplied safe move point", async () => {
    createRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
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

    expect(createRecoveryPoint).toHaveBeenCalledWith(expect.objectContaining({
      name: `Migration final ${migrationRunId}`,
      stopFirst: true
    }));
    expect(runRecoveryCreate).toHaveBeenCalledWith(sourceHostId, finalRecoveryPointId, {
      stopFirst: true,
      restartAfterStopFirst: false
    });
    expect(runRecoveryRestore).toHaveBeenCalledWith(targetHostId, expect.objectContaining({ recoveryPointId: finalRecoveryPointId }));
    expect(result.recoveryPointId).toBe(finalRecoveryPointId);
    expect(result.sourceLeftStopped).toBe(true);
  });

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
    createRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
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
      restartAfterStopFirst: false
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
    createRecoveryPoint
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
      restartAfterStopFirst: false
    });
    expect(stopContainersWithRestartOnFailure).not.toHaveBeenCalled();
    expect(result.recoveryPointId).toBe(finalRecoveryPointId);
    expect(result.sourceLeftStopped).toBe(true);
  });

  it("restarts source when final move capture fails after stopping it", async () => {
    const captureError = Object.assign(new Error("final capture failed"), {
      sourceStoppedIds: ["source-web"]
    });
    createRecoveryPoint.mockResolvedValueOnce({ id: finalRecoveryPointId });
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
    expect(runRecoveryRestore).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, "final capture failed; source restarted"]
    );
  });

  it("fails before target restore when required host folder capture is incomplete", async () => {
    getRecoveryPoint.mockResolvedValue({
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
    getRecoveryPoint.mockResolvedValue({
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("expected 0 Docker volume(s) and 1 host folder(s)")]
    );
  });

  it("cleans up standalone target containers and restarts source after failed move verification", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker inspect 'source-web'")) {
        return { code: 0, stdout: inspectPayload("web", true), stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return { code: 1, stdout: "", stderr: "missing target container" };
      }
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        return { code: 0, stdout: "", stderr: "" };
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
    expect(commands.some((command) => command.includes(`docker rm --force '${restoredName}'`))).toBe(true);
    expect(commands.some((command) => command.includes("docker compose"))).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs SET status = 'failed'"),
      [migrationRunId, expect.stringContaining("source restarted")]
    );
  });
});
