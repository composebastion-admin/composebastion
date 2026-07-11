import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const streamSshCommandLines = vi.fn();
const getAgentContainerUsage = vi.fn();
const runAgentDockerCommand = vi.fn();
const streamAgentContainerUsage = vi.fn();

class AgentHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

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

vi.mock("../src/services/agent.js", () => ({
  AgentHttpError,
  checkAgent: vi.fn(),
  getAgentContainerUsage,
  runAgentDockerCommand,
  streamAgentContainerLogs: vi.fn(),
  streamAgentContainerUsage
}));

const { getContainerUsage, streamContainerLogs, streamContainerUsage } = await import("../src/services/docker.js");

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

function agentHost(lastStatus: "unknown" | "online" | "offline" | "checking" = "online") {
  const value = host(lastStatus);
  return {
    ...value,
    public: { ...value.public, connectionMode: "agent" },
    connectionMode: "agent",
    ssh: null,
    agent: { url: "https://agent.example.test:8090", token: "a".repeat(32) }
  };
}

describe("container usage polling", () => {
  beforeEach(() => {
    getHostForWorker.mockReset();
    runSshCommand.mockReset();
    streamSshCommandLines.mockReset();
    getAgentContainerUsage.mockReset();
    runAgentDockerCommand.mockReset();
    streamAgentContainerUsage.mockReset();
  });

  it("uses the agent read endpoint without consuming the command endpoint", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    getAgentContainerUsage.mockResolvedValue([{ ID: "container-1", CPUPerc: "1.00%" }]);

    await expect(getContainerUsage("host-1")).resolves.toEqual([{ ID: "container-1", CPUPerc: "1.00%" }]);
    expect(runAgentDockerCommand).not.toHaveBeenCalled();
  });

  it("falls back to one legacy agent command only when the read endpoint is absent", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    getAgentContainerUsage.mockRejectedValue(new AgentHttpError("missing", 404));
    runAgentDockerCommand.mockResolvedValue({ stdout: '{"ID":"container-1"}\n', stderr: "", code: 0 });

    await expect(getContainerUsage("host-1")).resolves.toEqual([{ ID: "container-1" }]);
    expect(runAgentDockerCommand).toHaveBeenCalledTimes(1);
  });

  it("proxies the native agent usage stream", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    const stop = vi.fn();
    streamAgentContainerUsage.mockResolvedValue(stop);

    await expect(streamContainerUsage("host-1", vi.fn(), vi.fn())).resolves.toBe(stop);
    expect(streamAgentContainerUsage).toHaveBeenCalledTimes(1);
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
