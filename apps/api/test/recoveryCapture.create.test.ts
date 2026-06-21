import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getHostForWorker = vi.fn();
const resolveAppContext = vi.fn();
const stopContainersWithRestartOnFailure = vi.fn();
const startContainersOneByOne = vi.fn();
const writeRecoveryPointFile = vi.fn();
const enforceScheduledRecoveryRetention = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
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

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  hashFile: vi.fn(),
  readRecoveryPointFile: vi.fn(),
  safeRecoveryPointFile: vi.fn((recoveryPointId: string, storageKey: string) => `/tmp/${recoveryPointId}/${storageKey}`),
  writeRecoveryPointFile: (...args: unknown[]) => writeRecoveryPointFile(...args)
}));

vi.mock("../src/services/recoveryS3.js", () => ({
  buildS3ObjectKey: vi.fn(),
  createS3Client: vi.fn(),
  headRecoveryArtifactOnS3: vi.fn(),
  resolveRecoveryPointStatus: () => ({ status: "completed", error: null }),
  uploadRecoveryArtifactToS3: vi.fn()
}));

vi.mock("../src/services/docker.js", () => ({
  runDocker: vi.fn()
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
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM resource_snapshots")) {
      return {
        rows: [{
          data: {
            Names: "source-web",
            State: "running",
            Image: "nginx:alpine",
            Labels: {},
            Mounts: []
          }
        }]
      };
    }
    if (sql === "SELECT * FROM recovery_points WHERE id = $1") return { rows: [pointRow] };
    if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [metadataArtifactRow] };
    if (sql.includes("SELECT status FROM recovery_artifacts")) return { rows: [{ status: "completed" }] };
    if (sql.includes("SELECT COALESCE(SUM(size_bytes)")) return { rows: [{ total: 12 }] };
    return { rows: [] };
  });
}

describe("runRecoveryCreate stop-first restart behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    writeRecoveryPointFile.mockResolvedValue({ sizeBytes: 12, checksum: "sha256:manifest" });
    enforceScheduledRecoveryRetention.mockResolvedValue({ deletedIds: [], failures: [] });
  });

  it("restarts stopped containers by default after a stop-first capture", async () => {
    const { runRecoveryCreate } = await import("../src/services/recoveryCapture.js");
    const result = await runRecoveryCreate(hostId, recoveryPointId, { stopFirst: true });

    expect(stopContainersWithRestartOnFailure).toHaveBeenCalledWith(hostId, ["source-web"], ["source-web"]);
    expect(startContainersOneByOne).toHaveBeenCalledWith(hostId, ["source-web"]);
    expect(result).toMatchObject({
      recoveryPointId,
      captureMode: "stop-first",
      sourceLeftStopped: false,
      stoppedContainerIds: []
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
    expect(query.mock.calls.some((call) =>
      Array.isArray(call[1])
      && call[1][0] === recoveryPointId
      && call[1][1] === JSON.stringify({ sourceLeftStopped: true, stoppedContainerIds: ["source-web"] })
    )).toBe(true);
    expect(result).toMatchObject({
      recoveryPointId,
      sourceLeftStopped: true,
      stoppedContainerIds: ["source-web"]
    });
  });

  it("exposes stopped source ids when capture fails and restartAfterStopFirst is false", async () => {
    writeRecoveryPointFile.mockRejectedValueOnce(new Error("manifest write failed"));

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

    expect(writeRecoveryPointFile).not.toHaveBeenCalled();
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
});
