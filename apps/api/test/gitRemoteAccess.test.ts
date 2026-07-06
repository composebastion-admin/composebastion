import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const query = vi.fn();
const readHostTextFileFromWorker = vi.fn();
const recordStackVersion = vi.fn();
const checkImageUpdatesForHost = vi.fn();

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

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: vi.fn()
}));

vi.mock("../src/services/remoteFiles.js", () => ({
  readHostTextFileFromWorker: (...args: unknown[]) => readHostTextFileFromWorker(...args),
  stackRemoteDirectory: vi.fn(() => "/tmp/composebastion/stacks/test"),
  writeHostStackFiles: vi.fn()
}));

vi.mock("../src/services/stackVersions.js", () => ({
  recordStackVersion: (...args: unknown[]) => recordStackVersion(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: (...args: unknown[]) => checkImageUpdatesForHost(...args),
  findRegistryAuthForReference: vi.fn()
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "00000000-0000-4000-8000-000000000123";

describe("host git remote access checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostForWorker.mockResolvedValue({
      public: { dockerSocketPath: "/var/run/docker.sock", tags: [] },
      connectionMode: "ssh",
      ssh: { hostname: "vm.local", port: 22, username: "docker" },
      agent: null
    });
    checkImageUpdatesForHost.mockResolvedValue(undefined);
    recordStackVersion.mockResolvedValue(undefined);
    readHostTextFileFromWorker.mockImplementation(async (_hostId: string, file: string) => {
      if (file.endsWith(".env")) throw new Error("No env");
      return "services:\n  app:\n    build: .\n";
    });
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO compose_stacks")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000999",
            host_id: params[1],
            name: params[2],
            project_name: params[3],
            compose_yaml: params[4],
            env: params[5],
            status: "created",
            source_type: params[6],
            source_repository_url: params[7],
            source_branch: params[8],
            source_working_dir: params[9],
            source_compose_path: params[10]
          }]
        };
      }
      if (sql.includes("SELECT id, project_name, status, source_type FROM compose_stacks")) return { rows: [] };
      return { rows: [], rowCount: 1 };
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

  it("deploys tracked clone builds from the host working tree and updates repo metadata", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("test -d") && command.includes(".git")) return { code: 0, stdout: "no\n", stderr: "" };
      if (command.includes("git clone")) return { code: 0, stdout: "cloned\n", stderr: "" };
      if (command.includes("git rev-parse --is-inside-work-tree")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            currentCommit: "abc123",
            latestCommit: "abc123",
            branch: "main",
            repositoryUrl: "git@github-private-app:owner/private-app.git"
          }),
          stderr: ""
        };
      }
      if (command.includes("docker compose -p") && command.includes("private-app")) return { code: 0, stdout: "deployed\n", stderr: "" };
      if (command.includes("docker version")) return { code: 0, stdout: "25.0.0\n", stderr: "" };
      if (command.includes("docker compose version")) return { code: 0, stdout: "2.27.0\n", stderr: "" };
      if (command.includes("docker ps") || command.includes("docker image") || command.includes("docker network") || command.includes("docker volume")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    const result = await executeDockerAction({
      type: "git.cloneDeploy",
      hostId,
      payload: {
        repositoryId,
        repositoryUrl: "git@github-private-app:owner/private-app.git",
        directory: "/srv/apps/private-app",
        branch: "main",
        composePath: "docker-compose.yml",
        projectName: "private-app"
      }
    });

    expect(result).toMatchObject({
      repositoryUrl: "git@github-private-app:owner/private-app.git",
      branch: "main",
      currentCommitSha: "abc123",
      workingDir: "/srv/apps/private-app"
    });
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("git ls-remote"))).toBe(true);
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("git clone"))).toBe(true);
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("docker compose -p") && String(call[1]).includes("private-app"))).toBe(true);
    const stackInsert = query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO compose_stacks"));
    expect(stackInsert?.[1]).toEqual(expect.arrayContaining(["git", "git@github-private-app:owner/private-app.git", "main", "/srv/apps/private-app"]));
    const repoUpdate = query.mock.calls.find((call) => String(call[0]).includes("UPDATE github_repositories") && String(call[0]).includes("last_deployed_at"));
    expect(repoUpdate?.[1]).toEqual([repositoryId, "abc123", "abc123"]);
  });

  it("updates an existing host checkout origin before pulling tracked clone deploys", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("git ls-remote")) return { code: 0, stdout: "abc123\trefs/heads/main\n", stderr: "" };
      if (command.includes("test -d") && command.includes(".git")) return { code: 0, stdout: "yes\n", stderr: "" };
      if (command.includes("git remote set-url origin")) return { code: 0, stdout: "", stderr: "" };
      if (command.includes("git fetch --quiet --tags origin")) return { code: 0, stdout: "pulled\n", stderr: "" };
      if (command.includes("git rev-parse --is-inside-work-tree")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            currentCommit: "abc123",
            latestCommit: "abc123",
            branch: "main",
            repositoryUrl: "git@github-private-app:owner/private-app.git"
          }),
          stderr: ""
        };
      }
      if (command.includes("docker compose -p") && command.includes("private-app")) return { code: 0, stdout: "deployed\n", stderr: "" };
      if (command.includes("docker version")) return { code: 0, stdout: "25.0.0\n", stderr: "" };
      if (command.includes("docker compose version")) return { code: 0, stdout: "2.27.0\n", stderr: "" };
      if (command.includes("docker ps") || command.includes("docker image") || command.includes("docker network") || command.includes("docker volume")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    await executeDockerAction({
      type: "git.cloneDeploy",
      hostId,
      payload: {
        repositoryId,
        repositoryUrl: "git@github-private-app:owner/private-app.git",
        directory: "/srv/apps/private-app",
        branch: "main",
        composePath: "docker-compose.yml",
        projectName: "private-app"
      }
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const setOriginIndex = commands.findIndex((command) => command.includes("git remote set-url origin") && command.includes("git@github-private-app:owner/private-app.git"));
    const pullIndex = commands.findIndex((command) => command.includes("git fetch --quiet --tags origin"));
    expect(setOriginIndex).toBeGreaterThan(-1);
    expect(pullIndex).toBeGreaterThan(setOriginIndex);
  });
});
