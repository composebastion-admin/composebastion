import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args),
  markHostChecking: vi.fn(),
  markHostOffline: vi.fn(),
  markHostOnline: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  streamSshCommandLines: vi.fn()
}));

const hostId = "00000000-0000-4000-8000-000000000001";

describe("host git remote access checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostForWorker.mockResolvedValue({
      public: { dockerSocketPath: "/var/run/docker.sock", tags: [] },
      connectionMode: "ssh",
      ssh: { hostname: "vm.local", port: 22, username: "docker" },
      agent: null
    });
  });

  it("runs a read-only ls-remote check on the host", async () => {
    runSshCommand.mockResolvedValueOnce({
      code: 0,
      stdout: "abc123\trefs/heads/main\n",
      stderr: ""
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    const result = await executeDockerAction({
      type: "git.testRemote",
      hostId,
      payload: {
        repositoryUrl: "git@github.com:owner/private-app.git",
        branch: "main"
      }
    });

    expect(result).toMatchObject({
      repositoryUrl: "git@github.com:owner/private-app.git",
      branch: "main",
      refs: ["abc123\trefs/heads/main"]
    });
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain("GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --heads --tags");
  });

  it("adds deploy-key guidance to host git auth failures", async () => {
    runSshCommand.mockResolvedValueOnce({
      code: 128,
      stdout: "",
      stderr: "Permission denied (publickey)."
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "git.testRemote",
      hostId,
      payload: {
        repositoryUrl: "git@github.com:owner/private-app.git"
      }
    })).rejects.toThrow("read-only deploy key");
  });
});
