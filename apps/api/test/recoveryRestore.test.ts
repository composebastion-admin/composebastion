import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  buildCloneContainerName,
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  buildManagedRestoreBindPath,
  buildManagedRestoreStackPath
} from "../src/services/recoveryRestoreUtils.js";
import {
  currentRemoteMutationContext,
  RemoteMutationOutcomeUnknownError
} from "../src/services/remoteMutationProof.js";

const query = vi.fn();
const getHostForWorker = vi.fn();
const readRecoveryArtifact = vi.fn();
const withRecoveryArtifactLocalPath = vi.fn();
const runSshCommand = vi.fn();
const pipeFileToSshCommand = vi.fn();
const writeRemoteFile = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/recoveryArtifactStore.js", () => ({
  withRecoveryArtifactLocalPath: (...args: unknown[]) => withRecoveryArtifactLocalPath(...args),
  readRecoveryArtifact: (...args: unknown[]) => readRecoveryArtifact(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  pipeFileToSshCommand: (...args: unknown[]) => pipeFileToSshCommand(...args),
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

const recoveryPointId = "00000000-0000-4000-8000-000000000004";
const hostId = "00000000-0000-4000-8000-000000000002";
const projectName = buildCloneRestoreProjectName("standalone", recoveryPointId);
const restoredName = buildCloneContainerName("web", projectName);
const now = new Date("2026-06-15T12:00:00.000Z");
const restoreAttemptLabel = "com.composebastion.recovery.restore-attempt";
const restoreScopeLabel = "com.composebastion.recovery.restore-scope";
const restoreOwnerMarkerSuffix = ".composebastion-restore-owner";

function volumeOwnershipFromCreateCommand(command: string) {
  const attempt = new RegExp(`${restoreAttemptLabel}=([^']+)'`).exec(command)?.[1];
  const scope = new RegExp(`${restoreScopeLabel}=([^']+)'`).exec(command)?.[1];
  return attempt && scope ? `${attempt}|${scope}` : null;
}

function expectedOwnershipFromCleanupCommand(command: string) {
  return /"\$restore_owner" != '([^']+)'/.exec(command)?.[1] ?? null;
}

function directoryOwnershipFromAcquireCommand(command: string) {
  const owner = /printf '%s\\n' '([^']+\|[^']+)' > '[^']+\.composebastion-restore-owner\.acquire-[^']+\.building\/owner'/.exec(command)?.[1];
  const target = /printf '%s\\n' '([^']+)' > '[^']+\.composebastion-restore-owner\.acquire-[^']+\.building\/trusted-root'/.exec(command)?.[1];
  return owner && target
    ? {
        owner,
        ownerPath: `${target}${restoreOwnerMarkerSuffix}/owner`,
        markerPath: `${target}${restoreOwnerMarkerSuffix}`
      }
    : null;
}

function isOwnedDirectoryCleanupCommand(
  command: string,
  targetPath: string
) {
  return command.includes("restore_target_identity")
    && command.includes(
      `mv -T -n -- '${targetPath}' '${targetPath}.composebastion-delete-`
    );
}

function expectDockerComposeConfigValid(composeYaml: string) {
  if (spawnSync("docker", ["compose", "version"]).status !== 0) return;
  const result = spawnSync(
    "docker",
    ["compose", "-f", "-", "config"],
    { input: composeYaml, encoding: "utf8" }
  );
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({
    status: 0,
    stderr: ""
  });
}

const recoveryPointRow = {
  id: recoveryPointId,
  host_id: hostId,
  name: "Standalone point",
  app_identity: { kind: "standalone", containerIds: ["source-web"] },
  trigger_kind: "manual",
  status: "completed",
  backup_target_id: null,
  legacy_volume_backup_id: null,
  artifact_count: 1,
  completed_artifact_count: 1,
  total_bytes: null,
  error: null,
  metadata: { projectName: "standalone" },
  created_at: now,
  started_at: now,
  completed_at: now
};

const metadataArtifactRow = {
  id: "00000000-0000-4000-8000-000000000005",
  recovery_point_id: recoveryPointId,
  kind: "metadata",
  backup_target_id: null,
  storage_key: "manifest.json",
  size_bytes: 1,
  checksum: null,
  status: "completed",
  error: null,
  metadata: {},
  created_at: now,
  completed_at: now
};

const volumeArtifactRow = {
  id: "00000000-0000-4000-8000-000000000006",
  recovery_point_id: recoveryPointId,
  kind: "volume",
  backup_target_id: null,
  storage_key: "volumes/data.tar.gz",
  size_bytes: 12,
  checksum: "sha256:volume",
  status: "completed",
  error: null,
  metadata: { volumeName: "data" },
  created_at: now,
  completed_at: now
};

const composeArtifactRow = {
  id: "00000000-0000-4000-8000-000000000007",
  recovery_point_id: recoveryPointId,
  kind: "compose_yaml",
  backup_target_id: null,
  storage_key: "compose.yml",
  size_bytes: 52,
  checksum: "sha256:compose",
  status: "completed",
  error: null,
  metadata: { projectName: "demoapp" },
  created_at: now,
  completed_at: now
};

const hostFolderArtifactRow = {
  id: "00000000-0000-4000-8000-000000000008",
  recovery_point_id: recoveryPointId,
  kind: "host_folder",
  backup_target_id: null,
  storage_key: "host-folders/config.tar.gz",
  size_bytes: 24,
  checksum: "sha256:host-folder",
  status: "completed",
  error: null,
  metadata: { sourcePath: "/srv/app/config" },
  created_at: now,
  completed_at: now
};

const composeWorkingDirectoryArtifactRow = {
  ...hostFolderArtifactRow,
  id: "00000000-0000-4000-8000-00000000000a",
  storage_key: "host-folders/working-directory.tar.gz",
  metadata: {
    sourcePath: "/home/docker/DemoApp",
    role: "compose_working_dir",
    restorePath: "/home/docker/DemoApp"
  }
};

const envArtifactRow = {
  id: "00000000-0000-4000-8000-000000000009",
  recovery_point_id: recoveryPointId,
  kind: "env_file",
  backup_target_id: null,
  storage_key: ".env",
  size_bytes: 64,
  checksum: "sha256:env",
  status: "completed",
  error: null,
  metadata: {},
  created_at: now,
  completed_at: now
};

const manifest = {
  version: 1,
  recoveryPointId,
  hostId,
  appIdentity: { kind: "standalone", containerIds: ["source-web"] },
  captureMode: "online",
  originalRunningState: [{ id: "source-web", name: "web", running: true }],
  docker: { serverVersion: "29.0.0", composeVersion: "2.34.0" },
  compose: {
    projectName: null,
    stackId: null,
    workingDir: null,
    composePath: null,
    yaml: null,
    env: null
  },
  containers: [{
    id: "source-web",
    name: "web",
    image: "nginx:alpine",
    state: "running",
    running: true,
    ports: [],
    networks: ["bridge"],
    labels: {},
    restartPolicy: "unless-stopped",
    env: [],
    volumes: [],
    bindMounts: [],
    entrypoint: [],
    command: [],
    user: null,
    workingDir: null
  }],
  imageReferences: ["nginx:alpine"],
  artifacts: [],
  capturedAt: "2026-06-15T12:00:00.000Z"
};

function drillRestore(overrides: Record<string, unknown> = {}) {
  return {
    mode: "clone" as const,
    projectName,
    restoredVolumes: 0,
    restoredBindMounts: 0,
    composeRestored: false,
    standaloneContainersRestored: 1,
    restoredContainerNames: [restoredName],
    volumeMap: {},
    bindMap: {},
    portRemap: {},
    networkMap: {},
    ...overrides
  };
}

describe("recovery standalone restore cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow] };
      return { rows: [] };
    });
    getHostForWorker.mockResolvedValue({
      public: { tags: [], dockerSocketPath: "/var/run/docker.sock" },
      connectionMode: "ssh",
      ssh: { hostname: "host", port: 22, username: "root" }
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify(manifest)));
    withRecoveryArtifactLocalPath.mockImplementation(async (_point, _artifact, useArtifact) =>
      useArtifact("/tmp/recovery-artifact")
    );
    pipeFileToSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("removes a created standalone container when start fails", async () => {
    let containerOwner: string | null = null;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes(`docker start '${restoredName}'`)) return { code: 1, stdout: "", stderr: "start failed" };
      if (command.includes(`docker rm --force '${restoredName}'`)) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return { code: 0, stdout: containerOwner ?? "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("start failed");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes(`docker rm --force '${restoredName}'`))).toBe(true);
  });

  it("checks the lease after the final start mutation and compensates when ownership is lost", async () => {
    const leaseLost = new Error("restore lease lost after start");
    let containerOwner: string | null = null;
    let containerPresent = false;
    let containerStarted = false;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        containerPresent = true;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        containerPresent = false;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return containerPresent
          ? { code: 0, stdout: containerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes(`docker start '${restoredName}'`)) {
        containerStarted = true;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });
    const fence = {
      assertActive: vi.fn(async () => {
        if (containerStarted) throw leaseLost;
      }),
      withActiveLease: vi.fn()
    };

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    }, fence)).rejects.toBe(leaseLost);

    expect(containerPresent).toBe(false);
    expect(fence.assertActive).toHaveBeenCalled();
  });

  it("fences restore mutations by stable phase and preserves exact unknown-outcome proof without cleanup", async () => {
    const durableQuery = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 2,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (
          client: { query: typeof durableQuery }
        ) => Promise<T>
      ) => callback({ query: durableQuery })
    };
    let observedPhase: string | undefined;
    runSshCommand.mockImplementation(
      async (_ssh: unknown, command: string) => {
        if (
          command.includes("docker container inspect")
          && command.includes(`'${restoredName}'`)
        ) {
          return {
            code: 1,
            stdout: "",
            stderr: "not found"
          };
        }
        if (command.includes("docker create")) {
          const context = currentRemoteMutationContext();
          observedPhase = context?.phase;
          throw new RemoteMutationOutcomeUnknownError(
            context?.operationId ?? "a".repeat(64),
            context?.phase ?? "missing",
            "ssh",
            "running"
          );
        }
        return {
          code: 1,
          stdout: "",
          stderr: `unexpected command: ${command}`
        };
      }
    );

    const {
      RecoveryRestoreCleanupRequiredError,
      runRecoveryRestore
    } = await import("../src/services/recoveryRestore.js");
    const failure = await runRecoveryRestore(
      hostId,
      {
        recoveryPointId,
        targetHostId: hostId,
        options: { mode: "clone", remapPorts: false }
      },
      fence,
      { operationJobId: fence.jobId }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(
      RecoveryRestoreCleanupRequiredError
    );
    expect(failure).toMatchObject({
      remoteOutcomeUnknown: true
    });
    expect((failure as Error).message).toMatch(
      /^REMOTE_OUTCOME_UNKNOWN:/
    );
    expect(observedPhase).toBe(
      "recovery.restore.container.create"
    );
    expect(
      runSshCommand.mock.calls.some((call) =>
        String(call[1]).includes("docker rm --force")
      )
    ).toBe(false);
    expect(
      query.mock.calls.some((call) =>
        String(call[0]).includes(
          "status = 'cleanup_pending'"
        )
      )
    ).toBe(true);
  });

  it("includes cleanup failures when removing a created standalone container fails", async () => {
    let containerOwner: string | null = null;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes(`docker start '${restoredName}'`)) return { code: 1, stdout: "", stderr: "start failed" };
      if (command.includes(`docker rm --force '${restoredName}'`)) return { code: 1, stdout: "", stderr: "remove failed" };
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        expect(command).toContain("index .Config.Labels");
        expect(command).not.toContain("index .Labels");
        return { code: 0, stdout: containerOwner ?? "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow(`start failed; cleanup failed: container ${restoredName}: remove failed`);
  });

  it("connects standalone containers to remaining manifest networks before start", async () => {
    const networkOwners = new Map<string, string>();
    let containerOwner: string | null = null;
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend", "backend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      for (const networkName of [`${projectName}_frontend`, `${projectName}_backend`]) {
        if (command.includes("docker network inspect") && command.includes(`'${networkName}'`)) {
          return networkOwners.has(networkName)
            ? { code: 0, stdout: networkOwners.get(networkName) ?? "", stderr: "" }
            : { code: 1, stdout: "", stderr: "not found" };
        }
        if (command.includes("docker network create") && command.endsWith(`'${networkName}'`)) {
          const owner = volumeOwnershipFromCreateCommand(command);
          if (owner) networkOwners.set(networkName, owner);
          return owner
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 1, stdout: "", stderr: "missing ownership labels" };
        }
      }
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return { code: 0, stdout: containerOwner ?? "", stderr: "" };
      }
      if (command.includes(`docker network connect '${projectName}_backend' '${restoredName}'`)) return { code: 0, stdout: "", stderr: "" };
      if (command.includes(`docker start '${restoredName}'`)) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      command.includes("docker network create") && command.endsWith(`'${projectName}_frontend'`)
    )).toBe(true);
    expect(commands.some((command) =>
      command.includes("docker network create") && command.endsWith(`'${projectName}_backend'`)
    )).toBe(true);
    expect(commands.some((command) => command.includes(`--network '${projectName}_frontend'`))).toBe(true);
    expect(commands.some((command) => command.includes(`docker network connect '${projectName}_backend' '${restoredName}'`))).toBe(true);
  });

  it("cleans a completed standalone clone from its ownership ledger", async () => {
    const targetFrontend = `${projectName}_frontend`;
    const targetBackend = `${projectName}_backend`;
    const networks = new Set<string>();
    const networkOwners = new Map<string, string>();
    let containerOwner: string | null = null;
    let containerPresent = false;
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend", "backend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        [targetFrontend, targetBackend].some((name) => command.includes(`docker network rm '${name}'`))
        && command.includes("restore_owner=")
      ) {
        const networkName = [targetFrontend, targetBackend].find((name) =>
          command.includes(`docker network rm '${name}'`)
        );
        if (!networkName || networkOwners.get(networkName) !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        networks.delete(networkName);
        networkOwners.delete(networkName);
        return { code: 0, stdout: networkName, stderr: "" };
      }
      if (
        command.includes(`docker rm --force '${restoredName}'`)
        && command.includes("restore_owner=")
      ) {
        if (containerOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        containerPresent = false;
        containerOwner = null;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetFrontend}'`)) {
        return networks.has(targetFrontend)
          ? { code: 0, stdout: networkOwners.get(targetFrontend) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetBackend}'`)) {
        return networks.has(targetBackend)
          ? { code: 0, stdout: networkOwners.get(targetBackend) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (
        command.includes("docker network create")
        && [targetFrontend, targetBackend].some((name) => command.endsWith(`'${name}'`))
      ) {
        const networkName = [targetFrontend, targetBackend].find((name) => command.endsWith(`'${name}'`));
        const owner = volumeOwnershipFromCreateCommand(command);
        if (!networkName || !owner) return { code: 1, stdout: "", stderr: "missing ownership labels" };
        networks.add(networkName);
        networkOwners.set(networkName, owner);
        return { code: 0, stdout: networkName, stderr: "" };
      }
      if (command.includes("docker create")) {
        if (containerPresent) return { code: 1, stdout: "", stderr: "container already exists" };
        containerPresent = true;
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return containerPresent
          ? { code: 0, stdout: containerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes(`docker network connect '${targetBackend}' '${restoredName}'`)) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes(`docker start '${restoredName}'`)) {
        return containerPresent
          ? { code: 0, stdout: restoredName, stderr: "" }
          : { code: 1, stdout: "", stderr: "container missing" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const {
      runRecoveryRestore,
      runRecoveryRestoreWithCleanup
    } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });

    expect(completed.restore).toMatchObject({
      composeRestored: false,
      standaloneContainersRestored: 1
    });
    expect(containerPresent).toBe(true);
    expect(networks).toEqual(new Set([targetFrontend, targetBackend]));

    await completed.cleanup.cleanup();
    await completed.cleanup.cleanup();

    expect(containerPresent).toBe(false);
    expect(networks).toEqual(new Set());
    const cleanupCommands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(cleanupCommands.filter((command) =>
      command.includes(`docker rm --force '${restoredName}'`)
    )).toHaveLength(1);
    expect(cleanupCommands.filter((command) =>
      command.includes(`docker network rm '${targetBackend}'`)
    )).toHaveLength(1);
    expect(cleanupCommands.filter((command) =>
      command.includes(`docker network rm '${targetFrontend}'`)
    )).toHaveLength(1);

    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).resolves.toMatchObject({
      composeRestored: false,
      standaloneContainersRestored: 1
    });
  });

  it("cleans up standalone containers when a secondary network connect fails", async () => {
    const networkOwners = new Map<string, string>();
    let containerOwner: string | null = null;
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend", "backend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker network rm") && command.includes("restore_owner=")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker network inspect")) {
        const networkName = [`${projectName}_frontend`, `${projectName}_backend`].find((name) =>
          command.includes(`'${name}'`)
        );
        return networkName && networkOwners.has(networkName)
          ? { code: 0, stdout: networkOwners.get(networkName) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network create")) {
        const networkName = [`${projectName}_frontend`, `${projectName}_backend`].find((name) =>
          command.endsWith(`'${name}'`)
        );
        const owner = volumeOwnershipFromCreateCommand(command);
        if (networkName && owner) networkOwners.set(networkName, owner);
        return networkName && owner
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "missing ownership labels" };
      }
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return { code: 0, stdout: containerOwner ?? "", stderr: "" };
      }
      if (command.includes(`docker network connect '${projectName}_backend' '${restoredName}'`)) return { code: 1, stdout: "", stderr: "network missing" };
      if (command.includes(`docker rm --force '${restoredName}'`)) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("network missing");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes(`docker rm --force '${restoredName}'`))).toBe(true);
  });

  it("fails volume restore immediately when docker volume create fails", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow, volumeArtifactRow] };
      return { rows: [] };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker volume create")) return { code: 1, stdout: "", stderr: "volume create failed" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("volume create failed");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
  });

  it("refuses to merge a recovery volume into an existing target volume", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow, volumeArtifactRow] };
      return { rows: [] };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker volume inspect")) return { code: 0, stdout: "[]", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("already exists");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
  });

  it("does not claim or remove a volume concurrently created between inspect and create", async () => {
    const targetVolumeName = buildCloneVolumeName("data", projectName);
    let createReturned = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow, volumeArtifactRow] };
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker volume rm --force '${targetVolumeName}'`)) {
        return { code: 73, stdout: "", stderr: "ownership labels do not match" };
      }
      if (command.includes("docker volume inspect --format") && command.includes(`'${targetVolumeName}'`)) {
        return createReturned
          ? { code: 0, stdout: `concurrent-attempt|${recoveryPointId}`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker volume create") && command.endsWith(`'${targetVolumeName}'`)) {
        createReturned = true;
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("concurrently created or replaced by another owner");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      command.includes("restore_owner=") && command.includes("docker volume rm")
    )).toBe(true);
  });

  it("safely rejects a stale volume from another attempt in the same recovery scope", async () => {
    const targetVolumeName = buildCloneVolumeName("data", projectName);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow, volumeArtifactRow] };
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker volume inspect --format") && command.includes(`'${targetVolumeName}'`)) {
        return { code: 0, stdout: `interrupted-attempt|${recoveryPointId}`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("belongs to another attempt in this recovery scope");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("docker volume create"))).toBe(false);
    expect(commands.some((command) =>
      command.includes("docker volume rm")
    )).toBe(false);
  });

  it("does not claim or remove a network concurrently created after its initial inspect", async () => {
    const targetNetwork = `${projectName}_frontend`;
    let createReturned = false;
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker network rm '${targetNetwork}'`)) {
        return { code: 73, stdout: "", stderr: "ownership labels do not match" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetNetwork}'`)) {
        return createReturned
          ? { code: 0, stdout: `concurrent-attempt|${recoveryPointId}`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network create") && command.endsWith(`'${targetNetwork}'`)) {
        createReturned = true;
        return { code: 0, stdout: targetNetwork, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("restore network");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      command.includes("restore_owner=") && command.includes("docker network rm")
    )).toBe(true);
    expect(commands.some((command) => command.includes("docker create"))).toBe(false);
  });

  it("rejects an unrelated deterministic-name network instead of reusing it for a clone", async () => {
    const targetNetwork = `${projectName}_frontend`;
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker network inspect") && command.includes(`'${targetNetwork}'`)) {
        return { code: 0, stdout: "<no value>|<no value>", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("refusing to attach a clone to an unrelated deterministic-name network");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("docker network create"))).toBe(false);
    expect(commands.some((command) =>
      command.includes("docker network rm")
    )).toBe(false);
  });

  it("does not claim or remove a standalone container whose ownership verification mismatches", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        return { code: 73, stdout: "", stderr: "ownership labels do not match" };
      }
      if (command.includes("docker create")) {
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return { code: 0, stdout: `concurrent-attempt|${recoveryPointId}`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("restored container");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      command.includes("restore_owner=") && command.includes("docker rm")
    )).toBe(true);
    expect(commands.some((command) => command.includes("docker start"))).toBe(false);
  });

  it("removes only volumes created by a failed attempt and leaves the clone retryable", async () => {
    const cacheVolumeArtifactRow = {
      ...volumeArtifactRow,
      id: "00000000-0000-4000-8000-00000000000b",
      storage_key: "volumes/cache.tar.gz",
      metadata: { volumeName: "cache" }
    };
    const dataVolumeName = buildCloneVolumeName("data", projectName);
    const cacheVolumeName = buildCloneVolumeName("cache", projectName);
    const existingVolumes = new Set<string>();
    const volumeOwners = new Map<string, string>();
    let failCacheRestore = true;

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, volumeArtifactRow, cacheVolumeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      for (const volumeName of [dataVolumeName, cacheVolumeName]) {
        if (
          command.includes(`docker volume rm --force '${volumeName}'`)
          && command.includes("restore_owner=")
        ) {
          const expectedOwner = expectedOwnershipFromCleanupCommand(command);
          if (!existingVolumes.has(volumeName)) {
            return { code: 1, stdout: "", stderr: "No such volume" };
          }
          if (expectedOwner !== volumeOwners.get(volumeName)) {
            return { code: 73, stdout: "", stderr: "ownership mismatch" };
          }
          existingVolumes.delete(volumeName);
          volumeOwners.delete(volumeName);
          return { code: 0, stdout: volumeName, stderr: "" };
        }
        if (command.includes("docker volume inspect --format") && command.includes(`'${volumeName}'`)) {
          return existingVolumes.has(volumeName)
            ? { code: 0, stdout: volumeOwners.get(volumeName) ?? "", stderr: "" }
            : { code: 1, stdout: "", stderr: "not found" };
        }
        if (command.includes("docker volume create") && command.endsWith(`'${volumeName}'`)) {
          const owner = volumeOwnershipFromCreateCommand(command);
          if (!owner) return { code: 1, stdout: "", stderr: "missing ownership labels" };
          existingVolumes.add(volumeName);
          volumeOwners.set(volumeName, owner);
          return { code: 0, stdout: volumeName, stderr: "" };
        }
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });
    pipeFileToSshCommand.mockImplementation(async (_ssh: unknown, _sourcePath: string, command: string) => {
      if (failCacheRestore && command.includes(`${cacheVolumeName}:/volume`)) {
        return { code: 1, stdout: "", stderr: "cache archive failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("cache archive failed");

    expect(existingVolumes).toEqual(new Set());
    const failedAttemptCommands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(failedAttemptCommands.findIndex((command) =>
      command.includes(`docker volume rm --force '${cacheVolumeName}'`)
    )).toBeLessThan(failedAttemptCommands.findIndex((command) =>
      command.includes(`docker volume rm --force '${dataVolumeName}'`)
    ));

    failCacheRestore = false;
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).resolves.toMatchObject({
      restoredVolumes: 2,
      composeRestored: false
    });
    expect(existingVolumes).toEqual(new Set([dataVolumeName, cacheVolumeName]));
  });

  it("preserves a successor volume when its ownership labels change before cleanup", async () => {
    const targetVolumeName = buildCloneVolumeName("data", projectName);
    let volumeOwner: string | null = null;
    let volumePresent = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, volumeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command.includes(`docker volume rm --force '${targetVolumeName}'`)
        && command.includes("restore_owner=")
      ) {
        if (volumeOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership labels changed" };
        }
        volumePresent = false;
        volumeOwner = null;
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      if (command.includes("docker volume inspect --format") && command.includes(`'${targetVolumeName}'`)) {
        return volumePresent
          ? { code: 0, stdout: volumeOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker volume create") && command.endsWith(`'${targetVolumeName}'`)) {
        volumeOwner = volumeOwnershipFromCreateCommand(command);
        volumePresent = true;
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreWithCleanup } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });
    expect(completed.restore.restoredVolumes).toBe(1);

    volumeOwner = `successor-attempt|${recoveryPointId}`;
    await expect(completed.cleanup.cleanup()).rejects.toThrow("ownership labels changed");
    expect(volumePresent).toBe(true);
    expect(volumeOwner).toBe(`successor-attempt|${recoveryPointId}`);
  });

  it("does not restore or clean a host tree when a concurrent creator wins atomic acquisition", async () => {
    const targetBindPath = buildManagedRestoreBindPath(
      "/var/lib/composebastion/restores",
      recoveryPointId,
      "/srv/app/config"
    );
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, hostFolderArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (directoryOwnershipFromAcquireCommand(command)) {
        return {
          code: 73,
          stdout: "",
          stderr: `clone restore host folder ${targetBindPath} already exists or is reserved by another restore attempt`
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("reserved by another restore attempt");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const acquireCommand = commands.find((command) => directoryOwnershipFromAcquireCommand(command));
    expect(spawnSync("sh", ["-n", "-c", acquireCommand ?? ""]).status).toBe(0);
    expect(acquireCommand).toContain("while :; do");
    expect(acquireCommand).toContain("stat -c '%d:%i'");
    expect(acquireCommand).toContain(
      `${targetBindPath}${restoreOwnerMarkerSuffix}.acquire-`
    );
    expect(acquireCommand).toContain(
      `${targetBindPath}.acquire-`
    );
    expect(commands.some((command) =>
      isOwnedDirectoryCleanupCommand(command, targetBindPath)
    )).toBe(false);
  });

  it("rejects a host-tree acquisition when an existing parent component is symlinked", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, hostFolderArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (directoryOwnershipFromAcquireCommand(command)) {
        expect(command).toContain(
          `if [ ! -d "$restore_probe" ] || [ -L "$restore_probe" ]`
        );
        return { code: 76, stdout: "", stderr: "symlinked parent; refusing path traversal" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("symlinked parent");

    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
  });

  it("refuses host-tree cleanup when an owned path parent becomes symlinked", async () => {
    const targetBindPath = buildManagedRestoreBindPath(
      "/var/lib/composebastion/restores",
      recoveryPointId,
      "/srv/app/config"
    );
    let targetExists = false;
    let cleanupCommand = "";
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, hostFolderArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (directoryOwnershipFromAcquireCommand(command)) {
        targetExists = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        isOwnedDirectoryCleanupCommand(command, targetBindPath)
      ) {
        cleanupCommand = command;
        return { code: 76, stdout: "", stderr: "parent became symlinked; refusing cleanup" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreWithCleanup } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });

    await expect(completed.cleanup.cleanup()).rejects.toThrow("parent became symlinked");
    expect(targetExists).toBe(true);
    expect(spawnSync("sh", ["-n", "-c", cleanupCommand]).status).toBe(0);
    const targetPrefixCheck = cleanupCommand.indexOf(
      `restore_probe='${targetBindPath.slice(
        0,
        targetBindPath.lastIndexOf("/")
      )}'`
    );
    expect(targetPrefixCheck).toBeGreaterThanOrEqual(0);
    expect(targetPrefixCheck).toBeLessThan(
      cleanupCommand.indexOf(`mv -T -n -- '${targetBindPath}'`)
    );
  });

  it("preserves a successor host tree when its durable marker replaces this attempt before cleanup", async () => {
    const targetBindPath = buildManagedRestoreBindPath(
      "/var/lib/composebastion/restores",
      recoveryPointId,
      "/srv/app/config"
    );
    const markerPath = `${targetBindPath}${restoreOwnerMarkerSuffix}`;
    const directoryOwners = new Map<string, string>();
    let targetExists = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, hostFolderArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      const acquiredDirectory = directoryOwnershipFromAcquireCommand(command);
      if (acquiredDirectory) {
        targetExists = true;
        directoryOwners.set(acquiredDirectory.markerPath, acquiredDirectory.owner);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        isOwnedDirectoryCleanupCommand(command, targetBindPath)
      ) {
        if (directoryOwners.get(markerPath) !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 74, stdout: "", stderr: "ownership marker mismatch" };
        }
        targetExists = false;
        directoryOwners.delete(markerPath);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreWithCleanup } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });
    expect(completed.restore.restoredBindMounts).toBe(1);
    expect(targetExists).toBe(true);

    directoryOwners.set(markerPath, `successor-attempt|${recoveryPointId}`);
    await expect(completed.cleanup.cleanup()).rejects.toThrow("ownership marker mismatch");
    await expect(completed.cleanup.cleanup()).rejects.toThrow("ownership marker mismatch");

    expect(targetExists).toBe(true);
    expect(directoryOwners.get(markerPath)).toBe(`successor-attempt|${recoveryPointId}`);
    const cleanupCommands = runSshCommand.mock.calls.map((call) => String(call[1])).filter((command) =>
      isOwnedDirectoryCleanupCommand(command, targetBindPath)
    );
    expect(cleanupCommands).toHaveLength(2);
  });

  it("retries only transiently failed compensation actions and never replays completed cleanup", async () => {
    const targetBindPath = buildManagedRestoreBindPath(
      "/var/lib/composebastion/restores",
      recoveryPointId,
      "/srv/app/config"
    );
    let cleanupAttempts = 0;
    let targetExists = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) return { rows: [recoveryPointRow] };
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, hostFolderArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (directoryOwnershipFromAcquireCommand(command)) {
        targetExists = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        isOwnedDirectoryCleanupCommand(command, targetBindPath)
      ) {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          return { code: 1, stdout: "", stderr: "temporary SSH failure" };
        }
        targetExists = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreWithCleanup } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });

    await expect(completed.cleanup.cleanup()).rejects.toThrow("temporary SSH failure");
    expect(targetExists).toBe(true);
    await expect(completed.cleanup.cleanup()).resolves.toBeUndefined();
    expect(targetExists).toBe(false);
    await expect(completed.cleanup.cleanup()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
  });

  it("compensates a failed Compose clone in reverse order and permits retry", async () => {
    const composeProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const targetVolumeName = `${composeProjectName}_data`;
    const targetBindPath = buildManagedRestoreBindPath(
      "/var/lib/composebastion/restores",
      recoveryPointId,
      "/srv/app/config"
    );
    const targetFrontend = `${composeProjectName}_frontend`;
    const targetBackend = `${composeProjectName}_backend`;
    const stackDirectory = buildManagedRestoreStackPath(
      "/var/lib/composebastion/restores",
      recoveryPointId
    );
    const composePath = `${stackDirectory}/compose.yml`;
    const envPath = `${stackDirectory}/.env`;
    const composeContainer = `${composeProjectName}-web-1`;
    const composeVolumeArtifactRow = {
      ...volumeArtifactRow,
      metadata: { volumeName: "demoapp_data" }
    };
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        name: "demoapp-web-1",
        labels: { "com.docker.compose.service": "web" },
        networks: ["frontend", "backend"],
        volumes: [{ name: "demoapp_data", destination: "/data", readOnly: false }],
        bindMounts: [{ source: "/srv/app/config", destination: "/config", readOnly: false }]
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    volumes:",
          "      - data:/data",
          "      - /srv/app/config:/config",
          "    networks:",
          "      - frontend",
          "      - backend",
          "volumes:",
          "  data:",
          "networks:",
          "  frontend:",
          "  backend:"
        ].join("\n"),
        env: "APP_MODE=restore\n"
      }
    };
    const volumes = new Set<string>();
    const volumeOwners = new Map<string, string>();
    const networks = new Set<string>();
    const networkOwners = new Map<string, string>();
    const paths = new Set<string>();
    const directoryOwners = new Map<string, string>();
    let composeContainerOwner: string | null = null;
    let composeContainerPresent = false;
    let composeAttempts = 0;

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return {
          rows: [
            metadataArtifactRow,
            composeArtifactRow,
            envArtifactRow,
            composeVolumeArtifactRow,
            hostFolderArtifactRow
          ]
        };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => {
      if (artifact.kind === "metadata") return Buffer.from(JSON.stringify(composeManifest));
      if (artifact.kind === "compose_yaml") return Buffer.from(composeManifest.compose.yaml);
      if (artifact.kind === "env_file") return Buffer.from(composeManifest.compose.env);
      return Buffer.from("");
    });
    writeRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string) => {
      paths.add(remotePath);
    });
    pipeFileToSshCommand.mockImplementation(async (_ssh: unknown, _sourcePath: string, command: string) => {
      if (command.includes(`-C '${targetBindPath}'`)) paths.add(targetBindPath);
      return { code: 0, stdout: "", stderr: "" };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command.includes(`docker volume rm --force '${targetVolumeName}'`)
        && command.includes("restore_owner=")
      ) {
        const expectedOwner = expectedOwnershipFromCleanupCommand(command);
        if (!volumes.has(targetVolumeName)) {
          return { code: 1, stdout: "", stderr: "No such volume" };
        }
        if (expectedOwner !== volumeOwners.get(targetVolumeName)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        volumes.delete(targetVolumeName);
        volumeOwners.delete(targetVolumeName);
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      if (command.includes("docker volume inspect --format") && command.includes(`'${targetVolumeName}'`)) {
        return volumes.has(targetVolumeName)
          ? { code: 0, stdout: volumeOwners.get(targetVolumeName) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker volume create") && command.endsWith(`'${targetVolumeName}'`)) {
        const owner = volumeOwnershipFromCreateCommand(command);
        if (!owner) return { code: 1, stdout: "", stderr: "missing ownership labels" };
        volumes.add(targetVolumeName);
        volumeOwners.set(targetVolumeName, owner);
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      const acquiredDirectory = directoryOwnershipFromAcquireCommand(command);
      if (acquiredDirectory) {
        const targetPath = acquiredDirectory.markerPath.slice(0, -restoreOwnerMarkerSuffix.length);
        if (paths.has(targetPath) || directoryOwners.has(acquiredDirectory.markerPath)) {
          return { code: 73, stdout: "", stderr: "path already exists" };
        }
        paths.add(targetPath);
        directoryOwners.set(acquiredDirectory.markerPath, acquiredDirectory.owner);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("restore_owner=") && command.includes(restoreOwnerMarkerSuffix)) {
        const targetPath = [targetBindPath, stackDirectory].find((candidate) =>
          isOwnedDirectoryCleanupCommand(command, candidate)
        );
        if (!targetPath) return { code: 1, stdout: "", stderr: "unknown owned path" };
        const markerPath = `${targetPath}${restoreOwnerMarkerSuffix}`;
        if (directoryOwners.get(markerPath) !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 74, stdout: "", stderr: "ownership marker mismatch" };
        }
        for (const existingPath of [...paths]) {
          if (existingPath === targetPath || existingPath.startsWith(`${targetPath}/`)) paths.delete(existingPath);
        }
        directoryOwners.delete(markerPath);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        [targetFrontend, targetBackend].some((name) => command.includes(`docker network rm '${name}'`))
        && command.includes("restore_owner=")
      ) {
        const networkName = [targetFrontend, targetBackend].find((name) =>
          command.includes(`docker network rm '${name}'`)
        );
        if (!networkName || networkOwners.get(networkName) !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        networks.delete(networkName);
        networkOwners.delete(networkName);
        return { code: 0, stdout: networkName, stderr: "" };
      }
      if (
        command.includes(`docker rm --force '${composeContainer}'`)
        && command.includes("restore_owner=")
      ) {
        if (composeContainerOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        composeContainerPresent = false;
        composeContainerOwner = null;
        return { code: 0, stdout: composeContainer, stderr: "" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetFrontend}'`)) {
        return networks.has(targetFrontend)
          ? { code: 0, stdout: networkOwners.get(targetFrontend) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetBackend}'`)) {
        return networks.has(targetBackend)
          ? { code: 0, stdout: networkOwners.get(targetBackend) ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (
        command.includes("docker network create")
        && [targetFrontend, targetBackend].some((name) => command.endsWith(`'${name}'`))
      ) {
        const networkName = [targetFrontend, targetBackend].find((name) => command.endsWith(`'${name}'`));
        const owner = volumeOwnershipFromCreateCommand(command);
        if (!networkName || !owner) return { code: 1, stdout: "", stderr: "missing ownership labels" };
        networks.add(networkName);
        networkOwners.set(networkName, owner);
        return { code: 0, stdout: networkName, stderr: "" };
      }
      if (command.includes("docker ps --all --filter")) {
        return {
          code: 0,
          stdout: composeContainerPresent ? `${composeContainer}\n` : "",
          stderr: ""
        };
      }
      if (command.includes("docker network ls --filter") || command.includes("docker volume ls --filter")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${composeContainer}'`)) {
        if (
          !command.includes("index .Config.Labels")
          || command.includes("index .Labels")
        ) {
          return {
            code: 1,
            stdout: "",
            stderr:
              "template parsing error: map has no entry for key \"Labels\""
          };
        }
        return composeContainerPresent
          ? { code: 0, stdout: composeContainerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes(`mkdir -p '${stackDirectory}'`)) {
        paths.add(stackDirectory);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command.includes(` -p '${composeProjectName}'`)
        && command.includes(" up -d ")
      ) {
        composeAttempts += 1;
        composeContainerPresent = true;
        composeContainerOwner = networkOwners.get(targetBackend)
          ?? networkOwners.get(targetFrontend)
          ?? volumeOwners.get(targetVolumeName)
          ?? null;
        if (composeAttempts === 1) {
          return { code: 1, stdout: "", stderr: "compose boot failed" };
        }
        return { code: 0, stdout: "started", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const {
      runRecoveryRestore,
      runRecoveryRestoreWithCleanup
    } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("compose boot failed");

    expect(volumes).toEqual(new Set());
    expect(networks).toEqual(new Set());
    expect(paths).toEqual(new Set());
    expect(directoryOwners).toEqual(new Map());
    expect(composeContainerPresent).toBe(false);

    const failedAttemptCommands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const cleanupOrder = [
      `docker rm --force '${composeContainer}'`,
      `mv -T -n -- '${stackDirectory}'`,
      `docker network rm '${targetBackend}'`,
      `docker network rm '${targetFrontend}'`,
      `mv -T -n -- '${targetBindPath}'`,
      `docker volume rm --force '${targetVolumeName}'`
    ].map((fragment) => failedAttemptCommands.findIndex((command) => command.includes(fragment)));
    expect(cleanupOrder.every((index) => index >= 0)).toBe(true);
    expect(cleanupOrder).toEqual([...cleanupOrder].sort((left, right) => left - right));
    expect(failedAttemptCommands.some((command) =>
      command.includes(`docker network rm '${targetFrontend}'`)
    )).toBe(true);

    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });
    expect(completed.restore).toMatchObject({
      composeRestored: true,
      restoredVolumes: 1,
      restoredBindMounts: 1
    });
    expect(composeAttempts).toBe(2);
    expect(networks).toEqual(new Set([targetFrontend, targetBackend]));
    expect(volumes).toEqual(new Set([targetVolumeName]));
    expect(composeContainerPresent).toBe(true);
    const composeWrites = writeRemoteFile.mock.calls.filter((call) =>
      String(call[1]) === composePath
    );
    const writtenCompose = parse(String(composeWrites.at(-1)?.[2])) as {
      services: Record<string, { labels?: Record<string, string> }>;
      volumes: Record<string, { name?: string; external?: boolean }>;
      networks: Record<string, { name?: string; external?: boolean }>;
    };
    expect(writtenCompose.services.web.labels).toMatchObject({
      [restoreAttemptLabel]: expect.any(String),
      [restoreScopeLabel]: recoveryPointId
    });
    expect(writtenCompose.volumes.data).toEqual({
      name: targetVolumeName,
      external: true
    });
    expect(writtenCompose.networks[targetFrontend]).toEqual({
      name: targetFrontend,
      external: true
    });
    expect(writtenCompose.networks[targetBackend]).toEqual({
      name: targetBackend,
      external: true
    });
    expectDockerComposeConfigValid(String(composeWrites.at(-1)?.[2]));

    await completed.cleanup.cleanup();
    await completed.cleanup.cleanup();

    expect(networks).toEqual(new Set());
    expect(volumes).toEqual(new Set());
    expect(paths).toEqual(new Set());
    expect(directoryOwners).toEqual(new Map());
    expect(composeContainerPresent).toBe(false);
    const completedCleanupCommands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(completedCleanupCommands.some((command) =>
      command.includes(`docker network rm '${targetFrontend}'`)
    )).toBe(true);

    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).resolves.toMatchObject({
      composeRestored: true,
      restoredVolumes: 1,
      restoredBindMounts: 1
    });
    expect(composeAttempts).toBe(3);
  });

  it("refuses to clean a Compose container replaced by a successor after project startup", async () => {
    const composeProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const stackDirectory = buildManagedRestoreStackPath(
      "/var/lib/composebastion/restores",
      recoveryPointId
    );
    const composeContainer = `${composeProjectName}-web-1`;
    const targetDefaultNetwork = `${composeProjectName}_default`;
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        name: "demoapp-web-1",
        labels: { "com.docker.compose.service": "web" },
        networks: ["demoapp_default"]
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: "services:\n  web:\n    image: nginx:alpine\n    network_mode: bridge\n",
        env: ""
      }
    };
    let composeStarted = false;
    let successorContainerPresent = false;
    let defaultNetworkOwner: string | null = null;
    let defaultNetworkPresent = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, composeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => (
      artifact.kind === "metadata"
        ? Buffer.from(JSON.stringify(composeManifest))
        : Buffer.from(composeManifest.compose.yaml)
    ));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command.includes(`docker network rm '${targetDefaultNetwork}'`)
        && command.includes("restore_owner=")
      ) {
        if (defaultNetworkOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "network ownership mismatch" };
        }
        defaultNetworkPresent = false;
        defaultNetworkOwner = null;
        return { code: 0, stdout: targetDefaultNetwork, stderr: "" };
      }
      if (command.includes("docker network inspect") && command.includes(`'${targetDefaultNetwork}'`)) {
        return defaultNetworkPresent
          ? { code: 0, stdout: defaultNetworkOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network create") && command.endsWith(`'${targetDefaultNetwork}'`)) {
        defaultNetworkOwner = volumeOwnershipFromCreateCommand(command);
        defaultNetworkPresent = true;
        return { code: 0, stdout: targetDefaultNetwork, stderr: "" };
      }
      if (
        command.includes(`docker rm --force '${composeContainer}'`)
        && command.includes("restore_owner=")
      ) {
        return { code: 73, stdout: "", stderr: "successor ownership mismatch" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${composeContainer}'`)) {
        return successorContainerPresent
          ? { code: 0, stdout: `successor-attempt|${recoveryPointId}`, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      const acquiredDirectory = directoryOwnershipFromAcquireCommand(command);
      if (acquiredDirectory) return { code: 0, stdout: "", stderr: "" };
      if (
        isOwnedDirectoryCleanupCommand(command, stackDirectory)
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker ps --all --filter")) {
        return {
          code: 0,
          stdout: composeStarted && successorContainerPresent ? `${composeContainer}\n` : "",
          stderr: ""
        };
      }
      if (command.includes("docker network ls --filter") || command.includes("docker volume ls --filter")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes(`mkdir -p '${stackDirectory}'`)) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command.includes(` -p '${composeProjectName}'`)
        && command.includes(" up -d ")
      ) {
        composeStarted = true;
        successorContainerPresent = true;
        return { code: 0, stdout: "started", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("concurrently created or replaced by another owner");

    expect(successorContainerPresent).toBe(true);
    expect(defaultNetworkPresent).toBe(false);
    const composeWrite = writeRemoteFile.mock.calls.find((call) => String(call[1]).endsWith("/compose.yml"));
    expect(String(composeWrite?.[2])).toContain(restoreAttemptLabel);
    expect(String(composeWrite?.[2])).toContain(restoreScopeLabel);
    const writtenCompose = parse(String(composeWrite?.[2])) as {
      networks: Record<string, { name?: string; external?: boolean }>;
    };
    expect(writtenCompose.networks.default).toEqual({
      name: targetDefaultNetwork,
      external: true
    });
    expectDockerComposeConfigValid(String(composeWrite?.[2]));
    const cleanupCommands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(cleanupCommands.some((command) =>
      command.includes("restore_owner=") && command.includes(`docker rm --force '${composeContainer}'`)
    )).toBe(true);
  });

  it("refuses to overwrite or clean a preexisting clone stack directory", async () => {
    const composeProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const stackDirectory = buildManagedRestoreStackPath(
      "/var/lib/composebastion/restores",
      recoveryPointId
    );
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        labels: { "com.docker.compose.service": "web" }
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: "services:\n  web:\n    image: nginx:alpine\n    network_mode: bridge\n",
        env: ""
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, composeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => (
      artifact.kind === "metadata"
        ? Buffer.from(JSON.stringify(composeManifest))
        : Buffer.from(composeManifest.compose.yaml)
    ));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (directoryOwnershipFromAcquireCommand(command)) {
        return { code: 73, stdout: "", stderr: `clone restore stack directory ${stackDirectory} already exists` };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow(`clone restore stack directory ${stackDirectory} already exists`);

    expect(writeRemoteFile).not.toHaveBeenCalled();
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      isOwnedDirectoryCleanupCommand(command, stackDirectory)
    )).toBe(false);
    expect(commands.some((command) =>
      command.includes(` -p '${composeProjectName}'`)
    )).toBe(false);
  });

  it("isolates same-host Compose clones in the managed restored working directory", async () => {
    const restoreRoot =
      "/var/lib/composebastion/restores/qualification-tenant";
    const demoappProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const restoredDemoAppData = `${demoappProjectName}_data`;
    const restoredWorkingDirectory = buildManagedRestoreBindPath(
      restoreRoot,
      recoveryPointId,
      "/home/docker/DemoApp"
    );
    const stackDirectory =
      buildManagedRestoreStackPath(restoreRoot, recoveryPointId);
    let restoredVolumeOwner: string | null = null;
    const demoappVolumeArtifactRow = {
      ...volumeArtifactRow,
      metadata: { volumeName: "demoapp_data" }
    };
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        labels: { "com.docker.compose.service": "demoapp" },
        bindMounts: [
          { source: "/srv/app/config", destination: "/app/config", readOnly: true },
          { source: "/home/docker/DemoApp/data", destination: "/app/relative-data", readOnly: true }
        ]
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: "/home/docker/DemoApp",
        composePath: "docker-compose.release.yml",
        yaml: "services:\n  demoapp:\n    image: ghcr.io/composebastion-admin/demo-app:beta\n    network_mode: bridge\n    volumes:\n      - data:/app/data\n      - ${DATA_DIR}:/app/config:ro\n      - ./data:/app/relative-data:ro\nvolumes:\n  data:\n",
        env: "DATA_DIR=/srv/app/config\nUNRELATED_SETTING=retained\n"
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [
          metadataArtifactRow,
          composeArtifactRow,
          envArtifactRow,
          demoappVolumeArtifactRow,
          hostFolderArtifactRow,
          composeWorkingDirectoryArtifactRow
        ] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => {
      if (artifact.kind === "metadata") return Buffer.from(JSON.stringify(composeManifest));
      if (artifact.kind === "compose_yaml") return Buffer.from(String(composeManifest.compose.yaml));
      if (artifact.kind === "env_file") return Buffer.from(String(composeManifest.compose.env));
      return Buffer.from("");
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker volume inspect --format") && command.includes(`'${restoredDemoAppData}'`)) {
        return restoredVolumeOwner
          ? { code: 0, stdout: restoredVolumeOwner, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker volume create") && command.endsWith(`'${restoredDemoAppData}'`)) {
        restoredVolumeOwner = volumeOwnershipFromCreateCommand(command);
        return restoredVolumeOwner
          ? { code: 0, stdout: restoredDemoAppData, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing ownership labels" };
      }
      if (directoryOwnershipFromAcquireCommand(command)) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker ps --all --filter")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker network ls --filter")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker volume ls --filter")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker ps --format")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes(`mkdir -p '${restoredWorkingDirectory}'`)) return { code: 0, stdout: "", stderr: "" };
      if (
        command.includes(`cd '${stackDirectory}'`)
        && command.includes(
          `--project-directory '${restoredWorkingDirectory}'`
        )
        && command.includes(
          `-f '${stackDirectory}/docker-compose.release.yml'`
        )
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    const result = await runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: {
        mode: "clone",
        remapPorts: true,
        restoreRoot
      }
    });

    expect(result.composeRestored).toBe(true);
    expect(result.restoredBindMounts).toBe(2);
    expect(result.volumeMap.demoapp_data).toBe(restoredDemoAppData);
    expect(pipeFileToSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/recovery-artifact",
      expect.stringContaining(`${restoredDemoAppData}:/volume`)
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/docker-compose.release.yml`,
      expect.stringContaining("data:/app/data")
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/docker-compose.release.yml`,
      expect.stringContaining(`name: ${restoredDemoAppData}`)
    );
    const restoredBindPath = buildManagedRestoreBindPath(
      restoreRoot,
      recoveryPointId,
      "/srv/app/config"
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/docker-compose.release.yml`,
      expect.stringContaining(`${restoredBindPath}:/app/config:ro`)
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/docker-compose.release.yml`,
      expect.stringContaining(`${restoredWorkingDirectory}/data:/app/relative-data:ro`)
    );
    expect(writeRemoteFile).not.toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/docker-compose.release.yml`,
      expect.stringContaining("${DATA_DIR}:/app/config")
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `${stackDirectory}/.env`,
      "DATA_DIR=/srv/app/config\nUNRELATED_SETTING=retained\n"
    );
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => {
      const acquisition =
        directoryOwnershipFromAcquireCommand(command);
      return acquisition?.markerPath ===
        `${stackDirectory}${restoreOwnerMarkerSuffix}`;
    })).toBe(true);
    expect(commands.some((command) =>
      command.includes(`cd '${stackDirectory}'`)
      && command.includes(
        `--project-directory '${restoredWorkingDirectory}'`
      )
      && command.includes(
        `-f '${stackDirectory}/docker-compose.release.yml'`
      )
    )).toBe(true);
    expect(commands.some((command) =>
      command.includes(`/tmp/composebastion/${recoveryPointId}`)
    )).toBe(false);
    expect(commands.some((command) => command.includes("cd '/home/docker/DemoApp'"))).toBe(false);
  });

  it("fails a Compose restore when an inspected bind has no completed host-folder artifact", async () => {
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        labels: { "com.docker.compose.service": "demoapp" },
        bindMounts: [{ source: "/srv/app/config", destination: "/app/config", readOnly: true }]
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: "services:\n  demoapp:\n    image: alpine\n    network_mode: bridge\n    volumes:\n      - ${DATA_DIR}:/app/config:ro\n",
        env: "DATA_DIR=/srv/app/config\n"
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [
          metadataArtifactRow,
          composeArtifactRow,
          { ...hostFolderArtifactRow, status: "failed", error: "capture failed", completed_at: null }
        ] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => {
      if (artifact.kind === "metadata") return Buffer.from(JSON.stringify(composeManifest));
      if (artifact.kind === "compose_yaml") return Buffer.from(String(composeManifest.compose.yaml));
      return Buffer.from("");
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker ps --format")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: true }
    })).rejects.toThrow("incomplete required local data artifact");
    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });

  it("remaps an explicit Compose network name to the exact owned clone network", async () => {
    const composeProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const targetNetwork = `${composeProjectName}_appnet`;
    const composeContainer = `${composeProjectName}-web-1`;
    let networkOwner: string | null = null;
    let composeStarted = false;
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        name: "demoapp-web-1",
        labels: { "com.docker.compose.service": "web" },
        networks: ["shared_net"]
      }],
      networks: [{
        name: "shared_net",
        id: "network-id",
        driver: "bridge",
        scope: "local",
        internal: false,
        attachable: false,
        ingress: false,
        enableIPv6: false,
        ipam: { driver: "default", options: {}, config: [] },
        labels: {
          "com.docker.compose.project": "demoapp",
          "com.docker.compose.network": "appnet"
        },
        options: {}
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    networks: [appnet]",
          "networks:",
          "  appnet:",
          "    name: shared_net",
          "    external: true",
          ""
        ].join("\n"),
        env: ""
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, composeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => (
      artifact.kind === "metadata"
        ? Buffer.from(JSON.stringify(composeManifest))
        : Buffer.from(composeManifest.compose.yaml)
    ));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker network inspect") && command.includes(`'${targetNetwork}'`)) {
        return networkOwner
          ? { code: 0, stdout: networkOwner, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker network create") && command.endsWith(`'${targetNetwork}'`)) {
        networkOwner = volumeOwnershipFromCreateCommand(command);
        return networkOwner
          ? { code: 0, stdout: targetNetwork, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing ownership labels" };
      }
      if (directoryOwnershipFromAcquireCommand(command)) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker ps --all --filter")) {
        return { code: 0, stdout: composeStarted ? `${composeContainer}\n` : "", stderr: "" };
      }
      if (command.includes("docker network ls --filter") || command.includes("docker volume ls --filter")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${composeContainer}'`)) {
        return { code: 0, stdout: networkOwner ?? "", stderr: "" };
      }
      if (
        command.includes(` -p '${composeProjectName}'`)
        && command.includes(" up -d ")
      ) {
        composeStarted = true;
        return { code: 0, stdout: "started", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    const result = await runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false, networkMode: "clone" }
    });

    expect(result.networkMap).toMatchObject({
      shared_net: targetNetwork,
      appnet: targetNetwork
    });
    const composeWrite = writeRemoteFile.mock.calls.find((call) => String(call[1]).endsWith("/compose.yml"));
    const written = parse(String(composeWrite?.[2])) as {
      services: { web: { networks: string[] } };
      networks: Record<string, { name?: string; external?: boolean }>;
    };
    expect(written.services.web.networks).toEqual([targetNetwork]);
    expect(written.networks[targetNetwork]).toEqual({ name: targetNetwork, external: true });
    expect(String(composeWrite?.[2])).not.toContain("name: shared_net");
    expectDockerComposeConfigValid(String(composeWrite?.[2]));
  });

  it("reuses an ordinary Compose-managed network by exact engine name without creating or owning it", async () => {
    const composeProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const sourceNetwork = "demoapp_backend";
    const composeContainer = `${composeProjectName}-web-1`;
    let composeStarted = false;
    let composeOwner = "";
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        name: "demoapp-web-1",
        labels: { "com.docker.compose.service": "web" },
        networks: [sourceNetwork]
      }],
      networks: [{
        name: sourceNetwork,
        id: "source-network-id",
        driver: "bridge",
        scope: "local",
        internal: false,
        attachable: false,
        ingress: false,
        enableIPv6: false,
        ipam: { driver: "default", options: {}, config: [] },
        labels: {
          "com.docker.compose.project": "demoapp",
          "com.docker.compose.network": "backend"
        },
        options: {}
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    networks: [backend]",
          "networks:",
          "  backend:",
          "    driver: bridge",
          ""
        ].join("\n"),
        env: ""
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, composeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => (
      artifact.kind === "metadata"
        ? Buffer.from(JSON.stringify(composeManifest))
        : Buffer.from(composeManifest.compose.yaml)
    ));
    writeRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string, content: string) => {
      if (!remotePath.endsWith("/compose.yml")) return;
      const written = parse(content) as {
        services: { web: { labels: Record<string, string> } };
      };
      composeOwner = [
        written.services.web.labels[restoreAttemptLabel],
        written.services.web.labels[restoreScopeLabel]
      ].join("|");
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker network inspect '${sourceNetwork}'`)) {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (directoryOwnershipFromAcquireCommand(command)) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker ps --all --filter")) {
        return { code: 0, stdout: composeStarted ? `${composeContainer}\n` : "", stderr: "" };
      }
      if (command.includes("docker network ls --filter") || command.includes("docker volume ls --filter")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${composeContainer}'`)) {
        return { code: 0, stdout: composeOwner, stderr: "" };
      }
      if (command.includes("docker ps --format")) return { code: 0, stdout: "", stderr: "" };
      if (
        command.includes(` -p '${composeProjectName}'`)
        && command.includes(" up -d ")
      ) {
        composeStarted = true;
        return { code: 0, stdout: "started", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    const result = await runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false, networkMode: "reuse" }
    });

    expect(result.networkMap).toMatchObject({
      [sourceNetwork]: sourceNetwork,
      backend: sourceNetwork
    });
    const composeWrite = writeRemoteFile.mock.calls.find((call) => String(call[1]).endsWith("/compose.yml"));
    const written = parse(String(composeWrite?.[2])) as {
      services: { web: { networks: string[] } };
      networks: Record<string, { name?: string; external?: boolean }>;
    };
    expect(written.services.web.networks).toEqual([sourceNetwork]);
    expect(written.networks[sourceNetwork]).toEqual({ name: sourceNetwork, external: true });
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("docker network create"))).toBe(false);
    expect(commands.some((command) => command.includes("docker network rm"))).toBe(false);
    expectDockerComposeConfigValid(String(composeWrite?.[2]));
  });

  it("rejects a partial point with an incomplete external volume before any target mutation", async () => {
    const failedVolume = {
      ...volumeArtifactRow,
      status: "failed",
      error: "capture failed",
      completed_at: null,
      metadata: { volumeName: "production_data" }
    };
    const partialManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      containers: [{
        ...manifest.containers[0],
        labels: { "com.docker.compose.service": "web" },
        volumes: [{ name: "production_data", destination: "/data", readOnly: false }]
      }],
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: null,
        composePath: "compose.yml",
        yaml: [
          "services:",
          "  web:",
          "    image: nginx:alpine",
          "    network_mode: bridge",
          "    volumes: [data:/data]",
          "volumes:",
          "  data:",
          "    name: production_data",
          "    external: true",
          ""
        ].join("\n"),
        env: ""
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, status: "partial", metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, composeArtifactRow, failedVolume] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => (
      artifact.kind === "metadata"
        ? Buffer.from(JSON.stringify(partialManifest))
        : Buffer.from(partialManifest.compose.yaml)
    ));

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("incomplete required local data artifact");
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(pipeFileToSshCommand).not.toHaveBeenCalled();
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });

  it("allows a partial point when every required data artifact completed", async () => {
    const targetVolumeName = buildCloneVolumeName("data", projectName);
    let volumePresent = false;
    let volumeOwner: string | null = null;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, status: "partial" }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [metadataArtifactRow, volumeArtifactRow] };
      }
      return { rows: [] };
    });
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: []
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command.includes(`docker volume rm --force '${targetVolumeName}'`)
        && command.includes("restore_owner=")
      ) {
        if (volumeOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        volumePresent = false;
        volumeOwner = null;
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      if (command.includes("docker volume inspect --format") && command.includes(`'${targetVolumeName}'`)) {
        return volumePresent
          ? { code: 0, stdout: volumeOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes("docker volume create") && command.endsWith(`'${targetVolumeName}'`)) {
        volumePresent = true;
        volumeOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: targetVolumeName, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreWithCleanup } = await import("../src/services/recoveryRestore.js");
    const completed = await runRecoveryRestoreWithCleanup(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    });

    expect(completed.restore.restoredVolumes).toBe(1);
    expect(volumePresent).toBe(true);
    await completed.cleanup.cleanup();
    expect(volumePresent).toBe(false);
  });

  it("cleans an owned standalone container when post-create ownership verification is unavailable", async () => {
    let containerPresent = false;
    let containerOwner: string | null = null;
    let verificationPending = false;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        if (containerOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        containerPresent = false;
        containerOwner = null;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker create")) {
        containerPresent = true;
        containerOwner = volumeOwnershipFromCreateCommand(command);
        verificationPending = true;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        if (verificationPending) {
          verificationPending = false;
          return { code: 1, stdout: "", stderr: "temporary inspect failure" };
        }
        return containerPresent
          ? { code: 0, stdout: containerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow("temporary inspect failure");
    expect(containerPresent).toBe(false);
  });

  it("tears down a validated drill so the same point can be drilled repeatedly", async () => {
    let containerPresent = false;
    let containerOwner: string | null = null;
    let running = false;
    let createCount = 0;
    let cleanupCount = 0;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        if (containerOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        containerPresent = false;
        containerOwner = null;
        running = false;
        cleanupCount += 1;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker create")) {
        if (containerPresent) return { code: 1, stdout: "", stderr: "already exists" };
        containerPresent = true;
        containerOwner = volumeOwnershipFromCreateCommand(command);
        createCount += 1;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return containerPresent
          ? { code: 0, stdout: containerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes(`docker start '${restoredName}'`)) {
        running = true;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: `/${restoredName}`,
            State: { Running: running, Status: running ? "running" : "exited" },
            Mounts: [],
            NetworkSettings: { Networks: { bridge: {} } }
          }]),
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
    const request = {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone" as const, remapPorts: false }
    };
    await expect(runRecoveryRestoreDrill(hostId, request)).resolves.toMatchObject({
      standaloneContainersRestored: 1
    });
    await expect(runRecoveryRestoreDrill(hostId, request)).resolves.toMatchObject({
      standaloneContainersRestored: 1
    });
    expect(containerPresent).toBe(false);
    expect(createCount).toBe(2);
    expect(cleanupCount).toBe(2);
  });

  it("fails an unhealthy drill and still tears down its owned container", async () => {
    let containerPresent = false;
    let containerOwner: string | null = null;
    let cleanupCount = 0;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        if (containerOwner !== expectedOwnershipFromCleanupCommand(command)) {
          return { code: 73, stdout: "", stderr: "ownership mismatch" };
        }
        containerPresent = false;
        containerOwner = null;
        cleanupCount += 1;
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker create")) {
        containerPresent = true;
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return containerPresent
          ? { code: 0, stdout: containerOwner ?? "", stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (command.includes(`docker start '${restoredName}'`)) {
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: `/${restoredName}`,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: "unhealthy" }
            },
            Mounts: [],
            NetworkSettings: { Networks: { bridge: {} } }
          }]),
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestoreDrill(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow(`Recovery restore drill container ${restoredName} is unhealthy.`);

    expect(containerPresent).toBe(false);
    expect(cleanupCount).toBe(1);
  });

  it("fails a validated drill when teardown cannot remove its owned container", async () => {
    let containerOwner: string | null = null;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker rm --force '${restoredName}'`)) {
        return { code: 1, stdout: "", stderr: "teardown blocked" };
      }
      if (command.includes("docker create")) {
        containerOwner = volumeOwnershipFromCreateCommand(command);
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes("docker container inspect") && command.includes(`'${restoredName}'`)) {
        return { code: 0, stdout: containerOwner ?? "", stderr: "" };
      }
      if (command.includes(`docker start '${restoredName}'`)) {
        return { code: 0, stdout: restoredName, stderr: "" };
      }
      if (command.includes(`docker inspect '${restoredName}'`)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: `/${restoredName}`,
            State: { Running: true, Status: "running" },
            Mounts: [],
            NetworkSettings: { Networks: { bridge: {} } }
          }]),
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestoreDrill(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow(
      `Failed to clean up completed clone restore: container ${restoredName}: teardown blocked`
    );
  });

  it("validates only manifest-mounted bind paths and ignores auxiliary captured folders", async () => {
    const restoredWorkingDirectory = "/var/lib/composebastion/restores/point/working";
    const mountedNestedPath = `${restoredWorkingDirectory}/data`;
    const reusedNetwork = "demoapp_backend";
    runSshCommand.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{
        Name: `/${restoredName}`,
        State: { Running: true, Status: "running" },
        Mounts: [{ Type: "bind", Source: mountedNestedPath }],
        NetworkSettings: { Networks: { [reusedNetwork]: {} } }
      }]),
      stderr: ""
    });

    const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
    await expect(validateRecoveryRestoreDrill(
      hostId,
      drillRestore({
        bindMap: {
          "/home/docker/DemoApp": restoredWorkingDirectory,
          "/srv/manual-export": "/var/lib/composebastion/restores/point/manual"
        },
        networkMap: { demoapp_backend: reusedNetwork }
      }),
      undefined,
      {
        containers: [{
          restoredName,
          composeService: null,
          originallyRunning: true
        }],
        requiredVolumeNames: [],
        requiredBindPaths: [mountedNestedPath],
        requiredNetworkNames: [reusedNetwork]
      }
    )).resolves.toBeUndefined();
  });

  it("polls health until an originally-running container is stable", async () => {
    vi.useFakeTimers();
    try {
      let inspectCount = 0;
      runSshCommand.mockImplementation(async () => {
        inspectCount += 1;
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: `/${restoredName}`,
            State: {
              Running: true,
              Status: "running",
              Health: { Status: inspectCount === 1 ? "starting" : "healthy" }
            },
            Mounts: [],
            NetworkSettings: { Networks: { bridge: {} } }
          }]),
          stderr: ""
        };
      });

      const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
      const validation = validateRecoveryRestoreDrill(
        hostId,
        drillRestore(),
        undefined,
        {
          containers: [{
            restoredName,
            composeService: null,
            originallyRunning: true
          }],
          requiredVolumeNames: [],
          requiredBindPaths: [],
          requiredNetworkNames: []
        }
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(validation).resolves.toBeUndefined();
      expect(inspectCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows captured-stopped and successful one-shot containers but rejects failed exits", async () => {
    const inspect = (exitCode: number) => ({
      code: 0,
      stdout: JSON.stringify([{
        Name: `/${restoredName}`,
        State: { Running: false, Status: "exited", ExitCode: exitCode },
        Mounts: [],
        NetworkSettings: { Networks: { bridge: {} } }
      }]),
      stderr: ""
    });
    const expectations = {
      containers: [{
        restoredName,
        composeService: null,
        originallyRunning: false
      }],
      requiredVolumeNames: [],
      requiredBindPaths: [],
      requiredNetworkNames: []
    };
    const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");

    runSshCommand.mockResolvedValueOnce(inspect(0));
    await expect(
      validateRecoveryRestoreDrill(hostId, drillRestore(), undefined, expectations)
    ).resolves.toBeUndefined();

    runSshCommand.mockResolvedValueOnce(inspect(0));
    await expect(
      validateRecoveryRestoreDrill(hostId, drillRestore(), undefined, {
        ...expectations,
        containers: [{
          ...expectations.containers[0],
          originallyRunning: true
        }]
      })
    ).resolves.toBeUndefined();

    runSshCommand.mockResolvedValueOnce(inspect(17));
    await expect(
      validateRecoveryRestoreDrill(hostId, drillRestore(), undefined, expectations)
    ).rejects.toThrow(`${restoredName} exited with code 17`);
  });

  it("accepts a successful Compose one-shot that was running at capture", async () => {
    const composeProject = "restore-compose-drill";
    const composeContainer = `${composeProject}-migrate-1`;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker ps --all --filter")) {
        return { code: 0, stdout: `${composeContainer}\n`, stderr: "" };
      }
      if (command.includes("docker network ls --filter") || command.includes("docker volume ls --filter")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes(`docker inspect '${composeContainer}'`)) {
        return {
          code: 0,
          stdout: JSON.stringify([{
            Name: `/${composeContainer}`,
            Config: {
              Labels: { "com.docker.compose.service": "migrate" }
            },
            State: { Running: false, Status: "exited", ExitCode: 0 },
            Mounts: [],
            NetworkSettings: { Networks: { bridge: {} } }
          }]),
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
    await expect(validateRecoveryRestoreDrill(
      hostId,
      drillRestore({
        projectName: composeProject,
        composeRestored: true,
        standaloneContainersRestored: 0,
        restoredContainerNames: []
      }),
      undefined,
      {
        containers: [{
          restoredName: null,
          composeService: "migrate",
          originallyRunning: true
        }],
        requiredVolumeNames: [],
        requiredBindPaths: [],
        requiredNetworkNames: []
      }
    )).resolves.toBeUndefined();
  });

  it("does not certify an originally-running container with a missing exit code", async () => {
    vi.useFakeTimers();
    try {
      runSshCommand.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify([{
          Name: `/${restoredName}`,
          State: { Running: false, Status: "exited" },
          Mounts: [],
          NetworkSettings: { Networks: { bridge: {} } }
        }]),
        stderr: ""
      });
      const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
      const validation = validateRecoveryRestoreDrill(
        hostId,
        drillRestore(),
        undefined,
        {
          containers: [{
            restoredName,
            composeService: null,
            originallyRunning: true
          }],
          requiredVolumeNames: [],
          requiredBindPaths: [],
          requiredNetworkNames: []
        }
      );
      const assertion = expect(validation).rejects.toThrow("timed out waiting for stable containers");
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out instead of certifying a container whose health never stabilizes", async () => {
    vi.useFakeTimers();
    try {
      runSshCommand.mockResolvedValue({
        code: 0,
        stdout: JSON.stringify([{
          Name: `/${restoredName}`,
          State: {
            Running: true,
            Status: "running",
            Health: { Status: "starting" }
          },
          Mounts: [],
          NetworkSettings: { Networks: { bridge: {} } }
        }]),
        stderr: ""
      });
      const { validateRecoveryRestoreDrill } = await import("../src/services/recoveryRestore.js");
      const validation = validateRecoveryRestoreDrill(
        hostId,
        drillRestore(),
        undefined,
        {
          containers: [{
            restoredName,
            composeService: null,
            originallyRunning: true
          }],
          requiredVolumeNames: [],
          requiredBindPaths: [],
          requiredNetworkNames: []
        }
      );
      const assertion = expect(validation).rejects.toThrow("timed out waiting for stable containers");
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
