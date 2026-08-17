import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const streamSshCommandLines = vi.fn();
const getAgentContainerUsage = vi.fn();
const runAgentDockerCommand = vi.fn();
const streamAgentContainerUsage = vi.fn();
const getDemoContainerUsage = vi.fn();
const streamDemoContainerUsage = vi.fn();

const dockerStatsTombstone = {
  BlockIO: "0B / 0B",
  CPUPerc: "0.00%",
  Container: "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398",
  ID: "",
  MemPerc: "0.00%",
  MemUsage: "0B / 0B",
  Name: "--",
  NetIO: "0B / 0B",
  PIDs: "0"
};

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

vi.mock("../src/services/demo.js", () => ({
  demoInventorySummary: vi.fn(),
  execDemoContainer: vi.fn(),
  executeDemoDockerAction: vi.fn(),
  getDemoContainerLogs: vi.fn(),
  getDemoContainerStats: vi.fn(),
  getDemoContainerUsage,
  getDemoContainerVolumeMounts: vi.fn(),
  isDemoHost: (candidate: { tags?: string[] | null }) => Array.isArray(candidate.tags) && candidate.tags.includes("demo"),
  streamDemoContainerUsage
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

function demoHost() {
  const value = host("online");
  return {
    ...value,
    public: { ...value.public, tags: ["demo"] }
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
    getDemoContainerUsage.mockReset();
    streamDemoContainerUsage.mockReset();
  });

  it("uses the agent read endpoint without consuming the command endpoint", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    getAgentContainerUsage.mockResolvedValue([{ ID: "container-1", CPUPerc: "1.00%" }]);

    await expect(getContainerUsage("host-1")).resolves.toEqual([{ ID: "container-1", CPUPerc: "1.00%" }]);
    expect(runAgentDockerCommand).not.toHaveBeenCalled();
  });

  it("rejects an agent snapshot atomically when any forwarded row lacks identity", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    getAgentContainerUsage.mockResolvedValue([
      { ID: "container-1", CPUPerc: "1.00%" },
      { CPUPerc: "2.00%", MemPerc: "3.00%" }
    ]);

    await expect(getContainerUsage("host-1")).rejects.toThrow("Agent returned malformed container usage data");
    expect(runAgentDockerCommand).not.toHaveBeenCalled();
  });

  it("falls back to one legacy agent command only when the read endpoint is absent", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    getAgentContainerUsage.mockRejectedValue(new AgentHttpError("missing", 404));
    runAgentDockerCommand.mockResolvedValue({ stdout: '{"ID":"container-1"}\n', stderr: "", code: 0 });

    await expect(getContainerUsage("host-1")).resolves.toEqual([{ ID: "container-1" }]);
    expect(runAgentDockerCommand).toHaveBeenCalledTimes(1);
  });

  it("proxies only identified native agent stats without lifecycle tombstones", async () => {
    getHostForWorker.mockResolvedValue(agentHost());
    const stop = vi.fn();
    streamAgentContainerUsage.mockImplementation(async (_target, onStats) => {
      onStats({ ID: "container-1", Name: "web", CPUPerc: "1.00%" });
      onStats(dockerStatsTombstone);
      onStats({ ...dockerStatsTombstone, ID: "5fb479d76eb4" });
      onStats({ CPUPerc: "2.00%", MemPerc: "3.00%" });
      onStats({ Container: "5fb479d76eb4", CPUPerc: "4.00%" });
      return stop;
    });
    const stats: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];

    await expect(streamContainerUsage("host-1", (row) => stats.push(row), (error) => errors.push(error))).resolves.toBe(stop);
    expect(streamAgentContainerUsage).toHaveBeenCalledTimes(1);
    expect(stats).toEqual([
      { ID: "container-1", Name: "web", CPUPerc: "1.00%" },
      { ...dockerStatsTombstone, ID: "5fb479d76eb4" }
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "Docker stats row must include a container identity",
      "Docker stats row must include a container identity"
    ]);
  });

  it("rejects an entire SSH snapshot instead of filtering an identity-less row", async () => {
    getHostForWorker.mockResolvedValue(host("online"));
    runSshCommand.mockResolvedValue({
      stdout: '{"ID":"container-1","Name":"web","CPUPerc":"1.00%"}\n{"CPUPerc":"2.00%","MemPerc":"3.00%"}\n',
      stderr: "",
      code: 0
    });

    await expect(getContainerUsage("host-1")).rejects.toThrow("must include a container identity");
  });

  it("validates demo snapshots and stream rows at the forwarding boundary", async () => {
    getHostForWorker.mockResolvedValue(demoHost());
    getDemoContainerUsage.mockResolvedValue([
      { ID: "demo-1", Name: "demo-web" },
      { CPUPerc: "2.00%" }
    ]);
    await expect(getContainerUsage("host-1")).rejects.toThrow("Docker returned malformed container stats");

    const stop = vi.fn();
    streamDemoContainerUsage.mockImplementation(async (_hostId, onStats) => {
      onStats({ ID: "demo-1", Name: "demo-web", CPUPerc: "1.00%" });
      onStats(dockerStatsTombstone);
      onStats({ CPUPerc: "2.00%" });
      return stop;
    });
    const stats: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];

    await expect(streamContainerUsage("host-1", (row) => stats.push(row), (error) => errors.push(error))).resolves.toBe(stop);
    expect(stats).toEqual([{ ID: "demo-1", Name: "demo-web", CPUPerc: "1.00%" }]);
    expect(errors.map((error) => error.message)).toEqual(["Docker stats row must include a container identity"]);
  });

  it("parses ANSI SSH stats, ignores lifecycle tombstones, and reports malformed JSON", async () => {
    getHostForWorker.mockResolvedValue(host("online"));
    streamSshCommandLines.mockImplementation(async (_target, _command, onLine) => {
      onLine('\u001b[H{"ID":"container-1","Name":"web","CPUPerc":"1.00%"}\u001b[K');
      onLine(`\u001b[H${JSON.stringify({
        ...dockerStatsTombstone,
        CPUPerc: "0%",
        MemUsage: "0 bytes / 0 bytes",
        PIDs: 0
      })}\u001b[K`);
      onLine('\u001b[H{"CPUPerc":"2.00%","MemPerc":"3.00%"}\u001b[K');
      onLine('\u001b[H{"Container":"5fb479d76eb4","CPUPerc":"4.00%"}\u001b[K');
      onLine("\u001b[H[]\u001b[K");
      onLine("\u001b[Hnot-json\u001b[K");
      return () => undefined;
    });
    const stats: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];

    await streamContainerUsage("host-1", (row) => stats.push(row), (error) => errors.push(error));

    expect(stats).toEqual([{ ID: "container-1", Name: "web", CPUPerc: "1.00%" }]);
    expect(errors).toHaveLength(4);
    expect(errors.slice(0, 2).map((error) => error.message)).toEqual([
      "Docker stats row must include a container identity",
      "Docker stats row must include a container identity"
    ]);
    expect(errors[2]).toEqual(new Error("Docker stats row must be a JSON object"));
    expect(errors[3]).toBeInstanceOf(SyntaxError);
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
