import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/services/crypto.js";
import {
  deploymentEnvironmentBinding
} from "../src/services/deploymentEnvironment.js";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const query = vi.fn();
const readHostTextFileFromWorker = vi.fn();
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
  withTransaction: (callback: (client: { query: typeof query }) => Promise<unknown>) =>
    callback({ query })
}));

vi.mock("../src/services/remoteFiles.js", () => ({
  readHostTextFileFromWorker: (...args: unknown[]) => readHostTextFileFromWorker(...args),
  stackRemoteDirectory: vi.fn(() => "/tmp/composebastion/stacks/test"),
  writeHostStackFiles: vi.fn()
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: (...args: unknown[]) => checkImageUpdatesForHost(...args),
  findRegistryAuthForReference: vi.fn()
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const repositoryId = "00000000-0000-4000-8000-000000000123";
const jobId = "00000000-0000-4000-8000-000000000777";
const sourceCommitSha = "a".repeat(40);
const composeYaml = "services:\n  app:\n    build: .\n";
const composeSha256 = createHash("sha256")
  .update(composeYaml, "utf8")
  .digest("hex");
const environment = "SECRET_TOKEN='host-clone-secret'";
const environmentBinding = deploymentEnvironmentBinding(environment);

function trackedExecutionFence() {
  return {
    jobId,
    attemptCount: 1,
    assertActive: vi.fn().mockResolvedValue(undefined),
    withActiveLease: (
      callback: (client: { query: typeof query }) => Promise<unknown>
    ) => callback({ query })
  };
}

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
    readHostTextFileFromWorker.mockImplementation(async (_hostId: string, file: string) => {
      if (file.endsWith(".env")) throw new Error("No env");
      return composeYaml;
    });
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (
        sql.includes("FROM github_clone_deployment_jobs")
        && sql.includes("FOR UPDATE")
      ) {
        return {
          rows: [{
            repository_id: repositoryId,
            host_id: hostId,
            stack_id: null,
            source_repository_url:
              "https://github.com/owner/private-app",
            clone_repository_url:
              "git@github-private-app:owner/private-app.git",
            source_branch: "main",
            source_commit_sha: sourceCommitSha,
            source_compose_path: "docker-compose.yml",
            compose_yaml: composeYaml,
            compose_sha256: composeSha256,
            project_name: "private-app",
            working_dir: "/srv/apps/private-app",
            environment_encrypted: encryptSecret(environment),
            environment_binding: environmentBinding
          }],
          rowCount: 1
        };
      }
      if (
        sql.includes("FROM compose_stacks")
        && sql.includes("source_environment_encrypted")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO compose_stacks")) {
        return {
          rows: [{
            id: params[0],
            host_id: params[1],
            name: params[2],
            project_name: params[3],
            compose_yaml: params[4],
            env: params[5],
            status: "created",
            source_environment_encrypted: params[6],
            source_environment_binding: params[7],
            source_type: params[8],
            source_repository_url: params[9],
            source_branch: params[10],
            source_working_dir: params[11],
            source_compose_path: params[12]
          }],
          rowCount: 1
        };
      }
      if (
        sql.includes("FROM compose_stack_versions")
        && sql.includes("WHERE id = $1")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("MAX(version_number)")) {
        return { rows: [{ version_number: 1 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO compose_stack_versions")) {
        return {
          rows: [{
            id: params[0],
            stack_id: params[1],
            version_number: params[2],
            compose_yaml: params[3],
            env: params[4],
            source: params[5],
            note: params[6],
            created_by: params[7]
          }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE compose_stacks")
        && sql.includes("current_version_id")
      ) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (sql.includes("UPDATE operation_jobs")) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (sql.includes("UPDATE github_clone_deployment_jobs AS bindings")) {
        return {
          rows: [{ operation_job_id: jobId }],
          rowCount: 1
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
            currentCommit: sourceCommitSha,
            latestCommit: sourceCommitSha,
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
        projectName: "private-app",
        sourceCommitSha,
        composeSha256
      }
    }, trackedExecutionFence() as any);

    expect(result).toMatchObject({
      repositoryUrl: "git@github-private-app:owner/private-app.git",
      branch: "main",
      currentCommitSha: sourceCommitSha,
      sourceCommitSha,
      composeSha256,
      workingDir: "/srv/apps/private-app"
    });
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("git ls-remote"))).toBe(true);
    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("git clone"))).toBe(true);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("git checkout --quiet --detach")
      && String(call[1]).includes(sourceCommitSha)
    )).toBe(true);
    const composeCommands = runSshCommand.mock.calls
      .map((call) => String(call[1]))
      .filter((command) => command.includes("compose"));
    expect(composeCommands.some((command) =>
      command.includes("private-app")
      && command.includes(" up -d")
    )).toBe(true);
    const stackInsert = query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO compose_stacks"));
    expect(stackInsert?.[1]).toEqual(expect.arrayContaining(["git", "git@github-private-app:owner/private-app.git", "main", "/srv/apps/private-app"]));
    expect(decryptSecret(String(stackInsert?.[1]?.[6]))).toBe(environment);
    expect(stackInsert?.[1]?.[7]).toBe(environmentBinding);
    const repoUpdate = query.mock.calls.find((call) => String(call[0]).includes("UPDATE github_repositories") && String(call[0]).includes("last_deployed_at"));
    expect(repoUpdate).toBeUndefined();
    expect(JSON.stringify(runSshCommand.mock.calls.map((call) => call[1])))
      .not.toContain("host-clone-secret");
    expect(runSshCommand.mock.calls.some((call) =>
      (call[2] as { input?: string } | undefined)?.input === environment
    )).toBe(true);
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
            currentCommit: sourceCommitSha,
            latestCommit: sourceCommitSha,
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
        projectName: "private-app",
        sourceCommitSha,
        composeSha256
      }
    }, trackedExecutionFence() as any);

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const setOriginIndex = commands.findIndex((command) => command.includes("git remote set-url origin") && command.includes("git@github-private-app:owner/private-app.git"));
    const pullIndex = commands.findIndex((command) =>
      command.includes("git checkout --quiet --detach")
      && command.includes(sourceCommitSha)
    );
    expect(setOriginIndex).toBeGreaterThan(-1);
    expect(pullIndex).toBeGreaterThan(setOriginIndex);
    expect(commands.some((command) =>
      command.includes("git pull --ff-only")
    )).toBe(false);
  });
});
