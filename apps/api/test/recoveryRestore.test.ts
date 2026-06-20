import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCloneContainerName,
  buildCloneRestoreProjectName
} from "../src/services/recoveryRestoreUtils.js";

const query = vi.fn();
const getHostForWorker = vi.fn();
const readRecoveryArtifact = vi.fn();
const ensureRecoveryArtifactLocalPath = vi.fn();
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
  ensureRecoveryArtifactLocalPath: (...args: unknown[]) => ensureRecoveryArtifactLocalPath(...args),
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
    ensureRecoveryArtifactLocalPath.mockResolvedValue("/tmp/recovery-artifact");
    pipeFileToSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("removes a created standalone container when start fails", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker create")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes(`docker start '${restoredName}'`)) return { code: 1, stdout: "", stderr: "start failed" };
      if (command.includes(`docker rm --force '${restoredName}'`)) return { code: 0, stdout: "", stderr: "" };
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

  it("includes cleanup failures when removing a created standalone container fails", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker create")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes(`docker start '${restoredName}'`)) return { code: 1, stdout: "", stderr: "start failed" };
      if (command.includes(`docker rm --force '${restoredName}'`)) return { code: 1, stdout: "", stderr: "remove failed" };
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: false }
    })).rejects.toThrow(`start failed; cleanup failed: ${restoredName}: remove failed`);
  });

  it("connects standalone containers to remaining manifest networks before start", async () => {
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend", "backend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker network inspect")) return { code: 1, stdout: "", stderr: "not found" };
      if (command.includes("docker network create")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker create")) return { code: 0, stdout: "", stderr: "" };
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
    expect(commands.some((command) => command.includes(`docker network create '${projectName}_frontend'`))).toBe(true);
    expect(commands.some((command) => command.includes(`docker network create '${projectName}_backend'`))).toBe(true);
    expect(commands.some((command) => command.includes(`--network '${projectName}_frontend'`))).toBe(true);
    expect(commands.some((command) => command.includes(`docker network connect '${projectName}_backend' '${restoredName}'`))).toBe(true);
  });

  it("cleans up standalone containers when a secondary network connect fails", async () => {
    readRecoveryArtifact.mockResolvedValue(Buffer.from(JSON.stringify({
      ...manifest,
      containers: [{ ...manifest.containers[0], networks: ["frontend", "backend"] }]
    })));
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker network inspect")) return { code: 1, stdout: "", stderr: "not found" };
      if (command.includes("docker network create")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("docker create")) return { code: 0, stdout: "", stderr: "" };
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

  it("restores compose apps from the original source working directory on the target", async () => {
    const demoappProjectName = buildCloneRestoreProjectName("demoapp", recoveryPointId);
    const restoredDemoAppData = `${demoappProjectName}_data`;
    const demoappVolumeArtifactRow = {
      ...volumeArtifactRow,
      metadata: { volumeName: "demoapp_data" }
    };
    const composeManifest = {
      ...manifest,
      appIdentity: { kind: "compose" as const, projectName: "demoapp" },
      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: "/home/docker/DemoApp",
        composePath: "docker-compose.release.yml",
        yaml: "services:\n  demoapp:\n    image: ghcr.io/composebastion-admin/demo-app:beta\n    volumes:\n      - data:/app/data\nvolumes:\n  data:\n",
        env: ""
      }
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: [{ ...recoveryPointRow, metadata: { projectName: "demoapp" } }] };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow, composeArtifactRow, demoappVolumeArtifactRow] };
      return { rows: [] };
    });
    readRecoveryArtifact.mockImplementation(async (_point: unknown, artifact: { kind: string }) => {
      if (artifact.kind === "metadata") return Buffer.from(JSON.stringify(composeManifest));
      if (artifact.kind === "compose_yaml") return Buffer.from(String(composeManifest.compose.yaml));
      return Buffer.from("");
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(`docker volume inspect '${restoredDemoAppData}'`)) return { code: 1, stdout: "", stderr: "not found" };
      if (command.includes(`docker volume create '${restoredDemoAppData}'`)) return { code: 0, stdout: restoredDemoAppData, stderr: "" };
      if (command.includes("docker ps --format")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("mkdir -p '/home/docker/DemoApp'")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("cd '/home/docker/DemoApp'") && command.includes("-f '/home/docker/DemoApp/docker-compose.release.yml'")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    const result = await runRecoveryRestore(hostId, {
      recoveryPointId,
      targetHostId: hostId,
      options: { mode: "clone", remapPorts: true }
    });

    expect(result.composeRestored).toBe(true);
    expect(result.volumeMap.demoapp_data).toBe(restoredDemoAppData);
    expect(pipeFileToSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/recovery-artifact",
      expect.stringContaining(`${restoredDemoAppData}:/volume`)
    );
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      "/home/docker/DemoApp/docker-compose.release.yml",
      expect.stringContaining("data:/app/data")
    );
    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("cd '/home/docker/DemoApp'"))).toBe(true);
  });
});
