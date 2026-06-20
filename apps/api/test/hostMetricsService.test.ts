import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentHostStats = vi.fn();
const runDocker = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query
}));

vi.mock("../src/services/agent.js", () => ({
  getAgentHostStats
}));

vi.mock("../src/services/docker.js", () => ({
  runDocker
}));

vi.mock("../src/services/demo.js", () => ({
  isDemoHost: vi.fn(() => false)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand
}));

const { getFleetHostSnapshot, getHostMetricsSnapshot } = await import("../src/services/hostMetrics.js");

const baseHost = {
  public: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Test Host",
    hostname: "example.local",
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
    hostname: "example.local",
    port: 22,
    username: "docker",
    password: "secret",
    privateKey: "",
    passphrase: null
  },
  agent: null
};

function dockerInfo() {
  return {
    stdout: JSON.stringify({
      NCPU: 4,
      MemTotal: 8_589_934_592,
      OperatingSystem: "Linux",
      KernelVersion: "6.8.0",
      Architecture: "x86_64",
      ServerVersion: "29.0.0",
      Containers: 2,
      ContainersRunning: 1
    }),
    stderr: "",
    code: 0
  };
}

const sshSnapshot = `##stat
cpu  100 0 100 800 0 0 0 0 0 0
##mem
MemTotal:       8000000 kB
MemAvailable:   5000000 kB
SwapTotal:      2000000 kB
SwapFree:       1500000 kB
##load
0.10 0.20 0.30 1/100 123
##up
1234.56 1000.00
##net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 1000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0
##df
Filesystem     1B-blocks     Used Available Use% Mounted on
/dev/sda1     1000000000 250000000 750000000 25% /
`;

describe("host metrics service snapshots", () => {
  beforeEach(() => {
    query.mockResolvedValue({ rows: [{ total: "2", running: "1" }] });
    getAgentHostStats.mockReset();
    getHostForWorker.mockReset();
    getHostForWorker.mockResolvedValue(baseHost);
    runDocker.mockReset();
    runDocker.mockImplementation(async (_hostId: string, command: string) => {
      if (command.startsWith("docker info")) return dockerInfo();
      if (command.startsWith("docker compose")) return { stdout: "2.29.0\n", stderr: "", code: 0 };
      throw new Error(`Unexpected command ${command}`);
    });
    runSshCommand.mockReset();
    runSshCommand.mockResolvedValue({ stdout: sshSnapshot, stderr: "", code: 0 });
  });

  it("collects specs and stats through one docker info call", async () => {
    await getHostMetricsSnapshot("00000000-0000-4000-8000-000000000101");

    expect(runDocker.mock.calls.filter((call) => String(call[1]).startsWith("docker info"))).toHaveLength(1);
    expect(runDocker.mock.calls.filter((call) => String(call[1]).startsWith("docker compose"))).toHaveLength(1);
  });

  it("uses bounded fleet timeouts for docker specs and SSH stats", async () => {
    await getHostMetricsSnapshot("00000000-0000-4000-8000-000000000102", { mode: "fleet" });

    expect(runDocker.mock.calls.find((call) => String(call[1]).startsWith("docker info"))?.[2]).toBe(4_000);
    expect(runDocker.mock.calls.find((call) => String(call[1]).startsWith("docker compose"))?.[2]).toBe(4_000);
    expect(runSshCommand.mock.calls[0]?.[2]).toEqual({ timeoutMs: 4_000 });
  });

  it("shares in-flight and fresh fleet snapshots through a short per-host cache", async () => {
    const hostId = "00000000-0000-4000-8000-000000000104";

    const [first, second] = await Promise.all([
      getFleetHostSnapshot(hostId),
      getFleetHostSnapshot(hostId)
    ]);
    const third = await getFleetHostSnapshot(hostId);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(getHostForWorker).toHaveBeenCalledTimes(1);
    expect(runDocker.mock.calls.filter((call) => String(call[1]).startsWith("docker info"))).toHaveLength(1);
    expect(runDocker.mock.calls.filter((call) => String(call[1]).startsWith("docker compose"))).toHaveLength(1);
    expect(runSshCommand).toHaveBeenCalledTimes(1);
  });

  it("returns degraded stats when agent host stats fail after specs succeed", async () => {
    getHostForWorker.mockResolvedValue({
      ...baseHost,
      connectionMode: "agent",
      public: { ...baseHost.public, id: "00000000-0000-4000-8000-000000000103", connectionMode: "agent" },
      agent: { url: "http://agent.local", token: "token" }
    });
    getAgentHostStats.mockRejectedValue(new Error("not found"));

    const snapshot = await getHostMetricsSnapshot("00000000-0000-4000-8000-000000000103", { mode: "fleet" });

    expect(snapshot.degradedReason).toContain("not found");
    expect(snapshot.stats.cpuPercent).toBeNull();
    expect(snapshot.stats.disks).toEqual([]);
  });
});
