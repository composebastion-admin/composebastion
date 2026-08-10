import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());
const getRegistryForWorker = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: async (
    handler: (client: { query: typeof query }) => Promise<unknown>
  ) => handler({ query })
}));
vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker,
  markHostChecking: vi.fn(),
  markHostOffline: vi.fn(),
  markHostOnline: vi.fn()
}));
vi.mock("../src/services/ssh.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/ssh.js")>();
  return {
    ...original,
    runSshCommand
  };
});
vi.mock("../src/services/registries.js", () => ({
  getRegistryForWorker
}));
vi.mock("../src/services/demo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/demo.js")>();
  return {
    ...original,
    isDemoHost: () => false
  };
});
vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: vi.fn(),
  findRegistryAuthForReference: vi.fn(async () => null)
}));

const {
  DockerRemoteOutcomeUnknownError,
  executeDockerAction
} = await import("../src/services/docker.js");

const hostId = "11111111-1111-4111-8111-111111111111";

function sshHost() {
  return {
    public: {
      id: hostId,
      name: "Docker Host",
      hostname: "docker.example.test",
      port: 22,
      username: "docker",
      dockerSocketPath: "/var/run/docker.sock",
      connectionMode: "ssh",
      tags: [],
      lastStatus: "online"
    },
    connectionMode: "ssh",
    ssh: {
      hostname: "docker.example.test",
      port: 22,
      username: "docker",
      password: "ssh-secret"
    },
    agent: null
  };
}

function fence(assertActive: ReturnType<typeof vi.fn>) {
  return {
    assertActive,
    withActiveLease: vi.fn(async (
      handler: (client: { query: typeof query }) => Promise<unknown>
    ) => handler({ query }))
  };
}

describe("direct Docker mutation lease fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    getHostForWorker.mockResolvedValue(sshHost());
    runSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("does not start a remote mutation after its lease is already lost", async () => {
    const leaseLost = Object.assign(new Error("lease lost"), {
      code: "JOB_LEASE_LOST"
    });
    const executionFence = fence(vi.fn().mockRejectedValueOnce(leaseLost));

    await expect(executeDockerAction({
      type: "container.restart",
      hostId,
      payload: { containerId: "web" }
    }, executionFence as any)).rejects.toBe(leaseLost);

    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("stops before follow-up inventory when the lease is lost after mutation", async () => {
    const leaseLost = Object.assign(new Error("lease lost"), {
      code: "JOB_LEASE_LOST"
    });
    const assertActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(leaseLost);
    const executionFence = fence(assertActive);

    await expect(executeDockerAction({
      type: "container.restart",
      hostId,
      payload: { containerId: "web" }
    }, executionFence as any)).rejects.toBe(leaseLost);

    expect(runSshCommand).toHaveBeenCalledOnce();
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain(
      "docker restart"
    );
  });

  it("classifies a lost authoritative transport response as ambiguous", async () => {
    runSshCommand.mockRejectedValueOnce(
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
    );
    const executionFence = fence(vi.fn().mockResolvedValue(undefined));

    await expect(executeDockerAction({
      type: "container.stop",
      hostId,
      payload: { containerId: "web" }
    }, executionFence as any)).rejects.toBeInstanceOf(
      DockerRemoteOutcomeUnknownError
    );

    expect(runSshCommand).toHaveBeenCalledOnce();
  });

  it("sends SSH registry passwords only through stdin", async () => {
    const password = "registry-password-that-must-not-be-an-argument";
    getRegistryForWorker.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Private",
      url: "registry.example.test",
      username: "robot",
      password,
      insecure: false
    });
    const executionFence = fence(vi.fn().mockResolvedValue(undefined));

    await expect(executeDockerAction({
      type: "registry.login",
      hostId,
      payload: {
        registryId: "22222222-2222-4222-8222-222222222222"
      }
    }, executionFence as any)).resolves.toEqual({
      stdout: "",
      stderr: ""
    });

    const [, command, options] = runSshCommand.mock.calls[0] ?? [];
    expect(String(command)).toContain("--password-stdin");
    expect(String(command)).not.toContain(password);
    expect(options).toMatchObject({ input: password });
  });
});
