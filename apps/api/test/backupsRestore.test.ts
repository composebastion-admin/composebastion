import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const pipeReadableToSshCommand = vi.fn();
const stat = vi.fn();

vi.mock("node:fs", async () => {
  const { Readable } = await import("node:stream");
  return {
    createReadStream: vi.fn(() => Readable.from(["backup"])),
    createWriteStream: vi.fn()
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
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

const { runVolumeRestore } = await import("../src/services/backups.js");

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
  beforeEach(() => {
    vi.clearAllMocks();
    stat.mockResolvedValue({ size: 100 });
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
});
