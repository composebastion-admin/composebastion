import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostIds = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const writeRemoteFile = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));
vi.mock("../src/services/docker.js", () => ({
  executeDockerAction: vi.fn(),
  runDocker: vi.fn()
}));
vi.mock("../src/services/files.js", () => ({ statHostPath: vi.fn() }));
vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args),
  listHostIds: (...args: unknown[]) => listHostIds(...args)
}));
vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: vi.fn(),
  findRegistryAuthForReference: vi.fn()
}));
vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));
vi.mock("../src/services/ssh.js", () => ({
  readRemoteFile: vi.fn(),
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

const sshHost = {
  public: { id: "ssh-host" },
  connectionMode: "ssh",
  ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
  agent: null
};
const agentHost = {
  public: { id: "agent-host" },
  connectionMode: "agent",
  ssh: { hostname: "", port: 22, username: "" },
  agent: { url: "https://agent.example.test", token: "agent-token" }
};

describe("private Git credential residue cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSshCommand.mockReset();
    writeRemoteFile.mockReset();
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("sweeps legacy files and marker-owned private directories without following symlinks", async () => {
    listHostIds.mockResolvedValue(["ssh-host", "agent-host", "offline-host"]);
    getHostForWorker.mockImplementation(async (hostId: string) => {
      if (hostId === "ssh-host") return sshHost;
      if (hostId === "agent-host") return agentHost;
      throw new Error("ssh://admin:password@offline.example.test unavailable");
    });
    runSshCommand.mockResolvedValue({
      code: 0,
      stdout: "/tmp/composebastion-git-a.askpass\n/tmp/composebastion-git-a.credentials\n",
      stderr: ""
    });

    const { cleanupStaleDeploymentGitCredentialFiles } = await import("../src/services/deployments.js");
    const result = await cleanupStaleDeploymentGitCredentialFiles();

    expect(result).toEqual({
      checked: 3,
      cleaned: 2,
      failures: [{
        hostId: "offline-host",
        cleaned: 0,
        error: "ssh://offline.example.test unavailable"
      }]
    });
    expect(runSshCommand).toHaveBeenCalledTimes(1);
    const command = String(runSshCommand.mock.calls[0]?.[1]);
    expect(command).toContain("find /tmp -maxdepth 1 -type f");
    expect(command).toContain("-name 'composebastion-git-*.askpass'");
    expect(command).toContain("-name 'composebastion-git-*.credentials'");
    expect(command.match(/-user "\$\(id -un\)"/g)).toHaveLength(2);
    expect(command).toContain("-mmin +15");
    expect(command).toContain("-delete -print");
    expect(command).toContain("find /tmp -maxdepth 1 -mindepth 1 -type d");
    expect(command).toContain("-name 'composebastion-git-*'");
    expect(command).toContain(".composebastion-owner");
    expect(command).toContain("composebastion-git-credentials-v1:");
    expect(command).toContain("[ -L \"$credential_directory\" ]");
    expect(command).toContain("rm -rf -- \"$credential_directory\"");
  });

  it("atomically acquires a private directory, exclusively pre-creates files, and requires guarded cleanup", async () => {
    const credentialDirectory = "/tmp/composebastion-git-A1b2C3d4E5";
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${credentialDirectory}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const { deploymentAnalysisInternals } = await import("../src/services/deployments.js");
    const credential = await deploymentAnalysisInternals.gitCredentialEnvironment(
      "00000000-0000-4000-8000-000000000123",
      sshHost as never,
      "git-user",
      "git-secret"
    );

    expect(runSshCommand.mock.invocationCallOrder[0])
      .toBeLessThan(writeRemoteFile.mock.invocationCallOrder[0]!);
    expect(writeRemoteFile).toHaveBeenCalledTimes(2);
    expect(writeRemoteFile).toHaveBeenNthCalledWith(
      1,
      sshHost.ssh,
      `${credentialDirectory}/credentials`,
      expect.any(String)
    );
    expect(writeRemoteFile).toHaveBeenNthCalledWith(
      2,
      sshHost.ssh,
      `${credentialDirectory}/askpass`,
      expect.stringContaining(`${credentialDirectory}/credentials`)
    );
    expect(credential.prefix).toContain(`GIT_ASKPASS='${credentialDirectory}/askpass'`);
    expect(runSshCommand.mock.calls.every((call) => !String(call[1]).includes("git-secret"))).toBe(true);
    const acquireCommand = String(runSshCommand.mock.calls[1]?.[1]);
    expect(acquireCommand).toContain("mktemp -d '/tmp/composebastion-git-XXXXXXXXXX'");
    expect(acquireCommand).toContain("umask 077");
    expect(acquireCommand).toContain("set -C");
    expect(acquireCommand).toContain(`: > "$credential_directory/credentials"`);
    expect(acquireCommand).toContain(`: > "$credential_directory/askpass"`);

    await credential.cleanup();
    const cleanupCommand = String(runSshCommand.mock.calls.at(-1)?.[1]);
    expect(cleanupCommand).toContain(`[ -L '${credentialDirectory}' ]`);
    expect(cleanupCommand).toContain(`[ -L '${credentialDirectory}/.composebastion-owner' ]`);
    expect(cleanupCommand).toContain("credential_owner=");
    expect(cleanupCommand).toContain(`rm -rf -- '${credentialDirectory}'`);
  });

  it("fails closed before materializing new credentials when stale cleanup is unavailable", async () => {
    runSshCommand.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "find unavailable" });
    const { deploymentAnalysisInternals } = await import("../src/services/deployments.js");

    await expect(deploymentAnalysisInternals.gitCredentialEnvironment(
      "00000000-0000-4000-8000-000000000123",
      sshHost as never,
      "git-user",
      "git-secret"
    )).rejects.toThrow("Could not clean stale private Git credential files");
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });

  it("gives concurrent credential setups for one analysis distinct private directories", async () => {
    const directories = [
      "/tmp/composebastion-git-AAAAAA1111",
      "/tmp/composebastion-git-BBBBBB2222"
    ];
    let acquired = 0;
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.startsWith("find /tmp")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("mktemp -d")) {
        const directory = directories[acquired++]!;
        return { code: 0, stdout: `${directory}\n`, stderr: "" };
      }
      if (command.includes("chmod 0700") || command.includes("credential_owner=")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    });

    const { deploymentAnalysisInternals } = await import("../src/services/deployments.js");
    const [first, second] = await Promise.all([
      deploymentAnalysisInternals.gitCredentialEnvironment(
        "00000000-0000-4000-8000-000000000123",
        sshHost as never,
        "git-user",
        "git-secret"
      ),
      deploymentAnalysisInternals.gitCredentialEnvironment(
        "00000000-0000-4000-8000-000000000123",
        sshHost as never,
        "git-user",
        "git-secret"
      )
    ]);

    expect(first.prefix).not.toBe(second.prefix);
    expect(first.prefix).toContain(`${directories[0]}/askpass`);
    expect(second.prefix).toContain(`${directories[1]}/askpass`);
    expect(runSshCommand.mock.calls.filter((call) =>
      String(call[1]).includes("mktemp -d")
    )).toHaveLength(2);

    await Promise.all([first.cleanup(), second.cleanup()]);
    const cleanupCommands = runSshCommand.mock.calls
      .map((call) => String(call[1]))
      .filter((command) => command.includes("credential_owner="));
    expect(cleanupCommands).toHaveLength(2);
    expect(cleanupCommands[0]).toContain(directories[0]);
    expect(cleanupCommands[1]).toContain(directories[1]);
  });

  it("refuses to clean a credential path that has been replaced by a symlink", async () => {
    const credentialDirectory = "/tmp/composebastion-git-SYMLNK1234";
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${credentialDirectory}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 73, stdout: "", stderr: "ownership changed" });

    const { deploymentAnalysisInternals } = await import("../src/services/deployments.js");
    const credential = await deploymentAnalysisInternals.gitCredentialEnvironment(
      "00000000-0000-4000-8000-000000000123",
      sshHost as never,
      "git-user",
      "git-secret"
    );

    await expect(credential.cleanup()).rejects.toThrow(
      "Could not safely remove the temporary private Git credential directory"
    );
    const cleanupCommand = String(runSshCommand.mock.calls.at(-1)?.[1]);
    expect(cleanupCommand.indexOf(`[ -L '${credentialDirectory}' ]`))
      .toBeLessThan(cleanupCommand.indexOf(`rm -rf -- '${credentialDirectory}'`));
    expect(cleanupCommand).toContain(`[ -L '${credentialDirectory}/.composebastion-owner' ]`);
  });

  it("fails closed when exclusive credential-file acquisition loses a race", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 73,
        stdout: "",
        stderr: "Could not exclusively create private Git credential files."
      });

    const { deploymentAnalysisInternals } = await import("../src/services/deployments.js");
    await expect(deploymentAnalysisInternals.gitCredentialEnvironment(
      "00000000-0000-4000-8000-000000000123",
      sshHost as never,
      "git-user",
      "git-secret"
    )).rejects.toThrow("Could not atomically create a private Git credential directory");

    const acquireCommand = String(runSshCommand.mock.calls[1]?.[1]);
    expect(acquireCommand).toContain("set -C");
    expect(acquireCommand).toContain("Could not exclusively create private Git credential files");
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });
});
