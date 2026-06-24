import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const writeRemoteFile = vi.fn();
const query = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHost: vi.fn(),
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

const hostId = "11111111-1111-4111-8111-111111111111";

function sshHost(mode: "ssh" | "agent" = "ssh") {
  return {
    public: { dockerSocketPath: "/var/run/docker.sock" },
    connectionMode: mode,
    ssh: { hostname: "vm.local", port: 22, username: "docker" },
    agent: mode === "agent" ? { url: "http://vm.local:8090", token: "token" } : null
  };
}

describe("self update service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostForWorker.mockResolvedValue(sshHost());
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "4242\n", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("writes and starts a detached host-side self-update script", async () => {
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    const result = await runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "pinned",
      targetVersion: "1.0.1"
    });

    expect(result).toMatchObject({
      handoffStarted: true,
      pid: "4242",
      targetVersion: "1.0.1",
      logPath: "/srv/composebastion/.composebastion-self-update.log"
    });
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      "/srv/composebastion/.composebastion-self-update.sh",
      expect.stringContaining("COMPOSEBASTION_VERSION=1.0.1")
    );
    const script = String(writeRemoteFile.mock.calls[0]?.[2] ?? "");
    expect(script).toContain("docker compose -f 'docker-compose.image.yml' pull app worker");
    expect(script).toContain("docker compose -f 'docker-compose.image.yml' up -d app worker");
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain("nohup '/srv/composebastion/.composebastion-self-update.sh'");
  });

  it("requires SSH mode for the detached self-update handoff", async () => {
    getHostForWorker.mockResolvedValueOnce(sshHost("agent"));
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "latest",
      targetVersion: "latest"
    })).rejects.toThrow("requires the manager host to use SSH mode");
  });
});
