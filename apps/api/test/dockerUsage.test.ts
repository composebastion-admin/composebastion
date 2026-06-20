import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const streamSshCommandLines = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker,
  markHostChecking: vi.fn(),
  markHostOffline: vi.fn(),
  markHostOnline: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand,
  streamSshCommandLines
}));

const { getContainerUsage, streamContainerLogs } = await import("../src/services/docker.js");

function host(lastStatus: "unknown" | "online" | "offline" | "checking") {
  return {
    public: {
      id: "host-1",
      name: "Test Host",
      hostname: "example.local",
      port: 22,
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      dockerSocketPath: "/var/run/docker.sock",
      tags: [],
      lastStatus,
      lastSeenAt: null,
      lastError: null,
      dockerVersion: null,
      composeVersion: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    },
    connectionMode: "ssh",
    ssh: {
      hostname: "example.local",
      port: 22,
      username: "docker",
      password: "secret",
      privateKey: "",
      passphrase: null
    },
    agent: null
  };
}

describe("container usage polling", () => {
  beforeEach(() => {
    getHostForWorker.mockReset();
    runSshCommand.mockReset();
    streamSshCommandLines.mockReset();
  });

  it("does not attempt Docker stats against known-offline hosts", async () => {
    getHostForWorker.mockResolvedValue(host("offline"));

    await expect(getContainerUsage("host-1")).resolves.toEqual([]);
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("streams container logs without trimming or dropping blank lines", async () => {
    getHostForWorker.mockResolvedValue(host("online"));
    const lines: string[] = [];
    streamSshCommandLines.mockImplementation(async (_target, _command, onLine, _onError, options) => {
      onLine("  padded log line  ");
      onLine("");
      expect(options).toEqual({ preserveLineFormatting: true });
      return () => undefined;
    });

    await streamContainerLogs("host-1", "container-1", 500, (line) => lines.push(line), () => undefined);

    expect(lines).toEqual(["  padded log line  ", ""]);
  });
});
