import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const withTransaction = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const readRemoteFile = vi.fn();
const writeRemoteFile = vi.fn();
const recordStackVersion = vi.fn();
const checkImageUpdatesForHost = vi.fn();
const findRegistryAuthForReference = vi.fn();
const statAgentRemoteFile = vi.fn();
const writeAgentRemoteFile = vi.fn();
const runAgentDockerCommand = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args),
  markHostChecking: vi.fn(),
  markHostOffline: vi.fn(),
  markHostOnline: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  readRemoteFile: (...args: unknown[]) => readRemoteFile(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args),
  streamSshCommandLines: vi.fn()
}));

vi.mock("../src/services/stackVersions.js", () => ({
  recordStackVersion: (...args: unknown[]) => recordStackVersion(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: (...args: unknown[]) => checkImageUpdatesForHost(...args),
  findRegistryAuthForReference: (...args: unknown[]) => findRegistryAuthForReference(...args)
}));

vi.mock("../src/services/agent.js", () => ({
  checkAgent: vi.fn(),
  runAgentDockerCommand: (...args: unknown[]) => runAgentDockerCommand(...args),
  statAgentRemoteFile: (...args: unknown[]) => statAgentRemoteFile(...args),
  streamAgentContainerLogs: vi.fn(),
  writeAgentRemoteFile: (...args: unknown[]) => writeAgentRemoteFile(...args)
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const composeYaml = "services:\n  app:\n    image: nginx:alpine\n";

function sshOk(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

function stackRow() {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    host_id: hostId,
    name: "Sampleapp",
    project_name: "sampleapp",
    compose_yaml: composeYaml,
    env: "",
    status: "created",
    source_type: "host_files",
    source_working_dir: "/srv/sampleapp",
    source_compose_path: "/srv/sampleapp/docker-compose.yml",
    created_at: new Date(0),
    updated_at: new Date(0)
  };
}

describe("compose.writeDeployPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostForWorker.mockResolvedValue({
      public: { tags: [], dockerSocketPath: "/var/run/docker.sock" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.local" },
      agent: null
    });
    withTransaction.mockImplementation(async (callback) => callback({ query: vi.fn() }));
    recordStackVersion.mockResolvedValue({});
    checkImageUpdatesForHost.mockResolvedValue(undefined);
    findRegistryAuthForReference.mockResolvedValue(null);
    statAgentRemoteFile.mockResolvedValue({ exists: false, path: "/tmp/dockermender/apps/sampleapp/docker-compose.yml", type: null, size: null });
    writeAgentRemoteFile.mockResolvedValue(undefined);
    runAgentDockerCommand.mockResolvedValue(sshOk("ok\n"));
    readRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string) => {
      if (String(remotePath).endsWith(".env")) throw new Error("not found");
      return composeYaml;
    });
    writeRemoteFile.mockResolvedValue(undefined);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO compose_stacks")) return { rows: [stackRow()] };
      if (sql.includes("SELECT data FROM resource_snapshots")) return { rows: [] };
      return { rows: [] };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.startsWith("if test -f")) return sshOk("missing\t0\n");
      if (command.includes("docker version")) return sshOk("29.4.0\n");
      if (command.includes("docker compose version")) return sshOk("5.1.3\n");
      if (command.includes("docker ps --all") || command.includes("docker image ls") || command.includes("docker network ls") || command.includes("docker volume ls")) return sshOk("");
      return sshOk("ok\n");
    });
  });

  it("writes compose and env files before deploying from the target folder", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await executeDockerAction({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        composeYaml,
        env: "APP_PORT=8080\n",
        overwrite: false,
        pullBeforeDeploy: false
      }
    });

    expect(writeRemoteFile).toHaveBeenCalledWith(expect.anything(), "/srv/sampleapp/docker-compose.yml", composeYaml);
    expect(writeRemoteFile).toHaveBeenCalledWith(expect.anything(), "/srv/sampleapp/.env", "APP_PORT=8080\n");
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d"))).toBe(true);
    expect(recordStackVersion).toHaveBeenCalledWith(expect.objectContaining({ source: "host_files" }));
  });

  it("refuses to overwrite an existing compose file unless overwrite is true", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.startsWith("if test -f")) return sshOk("file\t123\n");
      return sshOk("");
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        composeYaml,
        overwrite: false,
        pullBeforeDeploy: false
      }
    })).rejects.toThrow("already exists");
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });

  it("runs compose pull before compose up when requested", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await executeDockerAction({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        composeYaml,
        overwrite: true,
        pullBeforeDeploy: true
      }
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const pullIndex = commands.findIndex((command) => command.includes("docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' pull"));
    const upIndex = commands.findIndex((command) => command.includes("docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d"));
    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(pullIndex);
  });

  it("logs into matching registries before compose deploy", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");
    const privateComposeYaml = "services:\n  app:\n    image: registry.example.com/acme/app:latest\n";
    findRegistryAuthForReference.mockResolvedValue({
      url: "registry.example.com",
      username: "deploy",
      password: "secret"
    });
    readRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string) => {
      if (String(remotePath).endsWith(".env")) throw new Error("not found");
      return privateComposeYaml;
    });

    await executeDockerAction({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        composeYaml: privateComposeYaml,
        overwrite: true,
        pullBeforeDeploy: false
      }
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const loginIndex = commands.findIndex((command) => command.includes("docker login 'registry.example.com'"));
    const upIndex = commands.findIndex((command) => command.includes("docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d"));
    expect(findRegistryAuthForReference).toHaveBeenCalledWith("registry.example.com/acme/app:latest");
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThan(loginIndex);
  });

  it("rejects agent write deployments outside the agent file root", async () => {
    getHostForWorker.mockResolvedValue({
      public: { tags: [], dockerSocketPath: "/var/run/docker.sock" },
      connectionMode: "agent",
      ssh: null,
      agent: { url: "http://agent.local", token: "token" }
    });
    statAgentRemoteFile.mockRejectedValue(new Error("Agent file access is limited to /tmp/dockermender"));
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        composeYaml,
        overwrite: false,
        pullBeforeDeploy: false
      }
    })).rejects.toThrow("/tmp/dockermender");
    expect(writeAgentRemoteFile).not.toHaveBeenCalled();
  });
});
