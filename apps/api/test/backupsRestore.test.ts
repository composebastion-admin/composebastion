import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const query = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const pipeReadableToSshCommand = vi.fn();
const stat = vi.fn();
const mkdtemp = vi.fn();
const rm = vi.fn();
const loadWorkerBackupTarget = vi.fn();
const assertBackupTargetS3EndpointAllowed = vi.fn();
const downloadRemoteArtifactAtomically = vi.fn();
const createReadStream = vi.fn();

vi.mock("node:fs", () => ({
  createReadStream: (...args: unknown[]) => createReadStream(...args),
  createWriteStream: vi.fn()
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  mkdtemp: (...args: unknown[]) => mkdtemp(...args),
  rename: vi.fn(),
  rm: (...args: unknown[]) => rm(...args),
  stat: (...args: unknown[]) => stat(...args),
  unlink: vi.fn(),
  writeFile: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  pipeReadableToSshCommand: (...args: unknown[]) => pipeReadableToSshCommand(...args),
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  streamSshCommandToFile: vi.fn()
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  assertBackupTargetS3EndpointAllowed: (...args: unknown[]) => assertBackupTargetS3EndpointAllowed(...args),
  loadWorkerBackupTarget: (...args: unknown[]) => loadWorkerBackupTarget(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  deleteRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => downloadRemoteArtifactAtomically(...args),
  headRemoteArtifact: vi.fn(),
  uploadRemoteArtifact: vi.fn()
}));

const { getBackupDownloadStream, runVolumeRestore } = await import("../src/services/backups.js");

const backupRow = {
  id: "00000000-0000-4000-8000-000000000001",
  host_id: "00000000-0000-4000-8000-000000000002",
  volume_name: "source_data",
  target_volume_name: null,
  file_name: "source_data.tar.gz",
  size_bytes: 100,
  status: "completed",
  error: null,
  created_at: new Date(0),
  completed_at: new Date(0),
  metadata: {}
};

const host = {
  public: {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Host",
    hostname: "host.local",
    port: 22,
    username: "docker",
    connectionMode: "ssh",
    sshAuthType: "password",
    dockerSocketPath: "/var/run/docker.sock",
    tags: [],
    lastStatus: "online",
    lastSeenAt: null,
    lastError: null,
    dockerVersion: null,
    composeVersion: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  connectionMode: "ssh",
  ssh: {
    hostname: "host.local",
    port: 22,
    username: "docker",
    password: "secret",
    privateKey: "",
    passphrase: null
  },
  agent: null
};

describe("volume restore overwrite guard", () => {
  let sourceStream: PassThrough;

  beforeEach(() => {
    vi.clearAllMocks();
    sourceStream = new PassThrough();
    createReadStream.mockReturnValue(sourceStream);
    stat.mockResolvedValue({ size: 100 });
    mkdtemp.mockResolvedValue("/tmp/.composebastion-hydrate-test");
    rm.mockResolvedValue(undefined);
    assertBackupTargetS3EndpointAllowed.mockResolvedValue(undefined);
    loadWorkerBackupTarget.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000003",
      name: "Remote backup target",
      kind: "s3",
      enabled: true,
      localCachePolicy: "remote_only",
      s3: {
        config: { bucket: "backups", endpoint: "https://s3.example.com" },
        credentials: { accessKeyId: "key", secretAccessKey: "secret" }
      }
    });
    downloadRemoteArtifactAtomically.mockResolvedValue({ sizeBytes: 100 });
    query.mockResolvedValue({ rows: [backupRow] });
    getHostForWorker.mockResolvedValue(host);
  });

  it("refuses to restore into an existing volume by default", async () => {
    runSshCommand.mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" });

    await expect(runVolumeRestore(host.public.id, backupRow.id, "existing_data")).rejects.toThrow("already exists");
    expect(pipeReadableToSshCommand).not.toHaveBeenCalled();
  });

  it("allows restoring into an existing volume when overwrite is explicit", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "existing_data", stderr: "" });
    pipeReadableToSshCommand.mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });

    await expect(runVolumeRestore(host.public.id, backupRow.id, "existing_data", true)).resolves.toMatchObject({ stdout: "ok" });
    expect(pipeReadableToSshCommand).toHaveBeenCalledTimes(1);
  });

  it("removes a remote-only temporary hydration after a successful restore consumer", async () => {
    const remoteBackupRow = {
      ...backupRow,
      backup_target_id: "00000000-0000-4000-8000-000000000003",
      remote_object_key: "backups/source_data.tar.gz",
      metadata: { localCachePolicy: "remote_only" }
    };
    query.mockResolvedValue({ rows: [remoteBackupRow] });
    stat
      .mockResolvedValueOnce({ size: 99 })
      .mockResolvedValueOnce({ size: 100 });
    runSshCommand
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "missing" })
      .mockResolvedValueOnce({ code: 0, stdout: "restored_data", stderr: "" });
    pipeReadableToSshCommand.mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });

    await expect(runVolumeRestore(host.public.id, backupRow.id, "restored_data")).resolves.toMatchObject({ stdout: "ok" });

    expect(downloadRemoteArtifactAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "s3" }),
      "backups/source_data.tar.gz",
      "/tmp/.composebastion-hydrate-test/artifact"
    );
    expect(rm).toHaveBeenCalledWith("/tmp/.composebastion-hydrate-test", {
      recursive: true,
      force: true
    });
    expect(rm).toHaveBeenCalledWith(
      expect.stringMatching(/source_data\.tar\.gz$/),
      { force: true }
    );
  });

  it("preserves a successful restore result when temporary cleanup fails", async () => {
    const remoteBackupRow = {
      ...backupRow,
      backup_target_id: "00000000-0000-4000-8000-000000000003",
      remote_object_key: "backups/source_data.tar.gz",
      metadata: { localCachePolicy: "remote_only" }
    };
    query.mockResolvedValue({ rows: [remoteBackupRow] });
    stat
      .mockResolvedValueOnce({ size: 99 })
      .mockResolvedValueOnce({ size: 100 });
    runSshCommand
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "missing" })
      .mockResolvedValueOnce({ code: 0, stdout: "restored_data", stderr: "" });
    pipeReadableToSshCommand.mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });
    rm.mockRejectedValueOnce(new Error("temporary cleanup failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(runVolumeRestore(host.public.id, backupRow.id, "restored_data"))
      .resolves.toMatchObject({ stdout: "ok" });

    expect(warn).toHaveBeenCalledWith(
      "Failed to clean a hydrated backup artifact",
      {
        backupId: backupRow.id,
        error: "temporary cleanup failed"
      }
    );
    warn.mockRestore();
  });

  it("removes a remote-only temporary hydration when the restore consumer fails", async () => {
    const remoteBackupRow = {
      ...backupRow,
      backup_target_id: "00000000-0000-4000-8000-000000000003",
      remote_object_key: "backups/source_data.tar.gz",
      metadata: { localCachePolicy: "remote_only" }
    };
    query.mockResolvedValue({ rows: [remoteBackupRow] });
    stat
      .mockResolvedValueOnce({ size: 99 })
      .mockResolvedValueOnce({ size: 100 });
    runSshCommand
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "missing" })
      .mockResolvedValueOnce({ code: 0, stdout: "restored_data", stderr: "" });
    pipeReadableToSshCommand.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "restore stream failed"
    });

    await expect(runVolumeRestore(host.public.id, backupRow.id, "restored_data"))
      .rejects.toThrow("restore stream failed");

    expect(rm).toHaveBeenCalledWith("/tmp/.composebastion-hydrate-test", {
      recursive: true,
      force: true
    });
    expect(rm).toHaveBeenCalledWith(
      expect.stringMatching(/source_data\.tar\.gz$/),
      { force: true }
    );
  });

  it("keeps a corrupt local artifact when remote-only hydration cannot be verified", async () => {
    const remoteBackupRow = {
      ...backupRow,
      backup_target_id: "00000000-0000-4000-8000-000000000003",
      remote_object_key: "backups/source_data.tar.gz",
      metadata: { localCachePolicy: "remote_only" }
    };
    query.mockResolvedValue({ rows: [remoteBackupRow] });
    stat.mockResolvedValueOnce({ size: 99 });
    downloadRemoteArtifactAtomically.mockRejectedValueOnce(new Error("remote download failed"));

    await expect(runVolumeRestore(host.public.id, backupRow.id, "restored_data"))
      .rejects.toThrow("remote download failed");

    expect(rm).toHaveBeenCalledWith("/tmp/.composebastion-hydrate-test", {
      recursive: true,
      force: true
    });
    expect(rm).not.toHaveBeenCalledWith(
      expect.stringMatching(/source_data\.tar\.gz$/),
      { force: true }
    );
  });

  it("forwards encrypted source read errors and cleans the remote-only hydration", async () => {
    const remoteBackupRow = {
      ...backupRow,
      backup_target_id: "00000000-0000-4000-8000-000000000003",
      remote_object_key: "backups/source_data.tar.gz",
      encryption: "app_secret",
      metadata: { localCachePolicy: "remote_only" }
    };
    query.mockResolvedValue({ rows: [remoteBackupRow] });
    stat
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce({ size: 100 });

    const download = await getBackupDownloadStream(backupRow.id);
    expect(download).not.toBeNull();
    const readError = new Error("hydrated source read failed");
    const forwardedError = new Promise<Error>((resolve) => {
      download!.stream.once("error", resolve);
    });

    sourceStream.emit("error", readError);

    await expect(forwardedError).resolves.toBe(readError);
    await vi.waitFor(() => {
      expect(rm).toHaveBeenCalledWith("/tmp/.composebastion-hydrate-test", {
        recursive: true,
        force: true
      });
    });
  });
});
