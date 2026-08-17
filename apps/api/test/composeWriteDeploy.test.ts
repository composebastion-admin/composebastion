import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { deploymentEnvironmentBinding } from "../src/services/deploymentEnvironment.js";
import { decryptSecret, encryptSecret } from "../src/services/crypto.js";

const query = vi.fn();
const withTransaction = vi.fn();
const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const readRemoteFile = vi.fn();
const writeRemoteFile = vi.fn();
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
    withTransaction.mockImplementation(async (callback) => callback({
      query: (...args: unknown[]) => query(...args)
    }));
    checkImageUpdatesForHost.mockResolvedValue(undefined);
    findRegistryAuthForReference.mockResolvedValue(null);
    statAgentRemoteFile.mockResolvedValue({ exists: false, path: "/tmp/composebastion/apps/sampleapp/docker-compose.yml", type: null, size: null });
    writeAgentRemoteFile.mockResolvedValue(undefined);
    runAgentDockerCommand.mockResolvedValue(sshOk("ok\n"));
    readRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string) => {
      if (String(remotePath).endsWith(".env")) throw new Error("not found");
      return composeYaml;
    });
    writeRemoteFile.mockResolvedValue(undefined);
    query.mockImplementation(async (
      sql: string,
      values: unknown[] = []
    ) => {
      if (
        sql.includes("FROM compose_stacks")
        && sql.includes("source_environment_encrypted")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO compose_stacks")) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
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
            id: values[0],
            stack_id: values[1],
            version_number: values[2],
            compose_yaml: values[3],
            env: values[4],
            source: values[5],
            note: values[6],
            created_by: values[7]
          }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE compose_stacks")
        && sql.includes("current_version_id")
      ) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("UPDATE operation_jobs")) {
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
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
    expect(query.mock.calls.some(([sql, values]) =>
      String(sql).includes("INSERT INTO compose_stack_versions")
      && (values as unknown[])?.[5] === "host_files"
    )).toBe(true);
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

  it("pulls the existing Git checkout before deploying without replacing its origin", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await executeDockerAction({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        gitPullBeforeDeploy: true,
        branch: "main"
      }
    });

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const gitPullIndex = commands.findIndex((command) =>
      command.includes("git fetch --quiet --tags origin")
    );
    const composeUpIndex = commands.findIndex((command) =>
      command.includes("docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d")
    );
    expect(gitPullIndex).toBeGreaterThanOrEqual(0);
    expect(composeUpIndex).toBeGreaterThan(gitPullIndex);
    expect(commands.some((command) => command.includes("git remote set-url"))).toBe(false);
  });

  it("does not deploy when the fenced Git pull fails", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("git fetch --quiet --tags origin")) {
        return { code: 1, stdout: "", stderr: "pull failed" };
      }
      return sshOk("");
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml",
        gitPullBeforeDeploy: true,
        branch: "main"
      }
    })).rejects.toThrow("pull failed");

    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("docker compose")
    )).toBe(false);
  });

  it("does not persist stack state before the fenced Compose deployment succeeds", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes(
        "docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d"
      )) {
        return {
          code: 1,
          stdout: "",
          stderr: "remote compose failed before completion"
        };
      }
      return sshOk("");
    });
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml"
      }
    })).rejects.toThrow("remote compose failed before completion");

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stack_versions")
    )).toBe(false);
  });

  it("retains the encrypted intent and reports ambiguity when local finalization fails after Compose up", async () => {
    const normalQuery = query.getMockImplementation()!;
    query.mockImplementation(async (
      sql: string,
      values: unknown[] = []
    ) => {
      if (sql.includes("INSERT INTO compose_stacks")) {
        throw new Error("postgres unavailable after remote up");
      }
      return normalQuery(sql, values);
    });
    const executionFence = {
      jobId: "00000000-0000-4000-8000-000000000099",
      attemptCount: 2,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml"
      }
    }, executionFence)).rejects.toThrow("REMOTE_OUTCOME_UNKNOWN");

    const intentWriteIndex = query.mock.calls.findIndex(([sql, values]) =>
      String(sql).includes("UPDATE operation_jobs")
      && (values as unknown[])?.[3] === "composeStackDeploymentIntent"
    );
    const upIndex = runSshCommand.mock.calls.findIndex((call) =>
      String(call[1]).includes(
        "docker compose -p 'sampleapp' -f '/srv/sampleapp/docker-compose.yml' up -d"
      )
    );
    expect(intentWriteIndex).toBeGreaterThanOrEqual(0);
    expect(upIndex).toBeGreaterThanOrEqual(0);
    expect(query.mock.invocationCallOrder[intentWriteIndex])
      .toBeLessThan(runSshCommand.mock.invocationCallOrder[upIndex]!);

    const encryptedIntent = String(
      query.mock.calls[intentWriteIndex]?.[1]?.[4]
    );
    expect(encryptedIntent).toMatch(/^v1:/);
    expect(encryptedIntent).not.toContain(composeYaml);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("result - $4::text")
    )).toBe(false);
  });

  it("commits stack, version, deployment source, and analysis in the same leased transaction", async () => {
    const analysisId = "00000000-0000-4000-8000-000000000088";
    const sourceId = "00000000-0000-4000-8000-000000000077";
    const secretEnvironment = "MODE=production\nAPI_TOKEN=atomic-secret\n";
    const protectedEnvironment = "MODE='production'\nAPI_TOKEN=''";
    const analysis = {
      id: analysisId,
      source_id: null,
      source_type: "compose_upload",
      display_name: "Sample App",
      source_locator: "inline:sampleapp",
      branch: null,
      compose_path: "docker-compose.yml",
      working_dir: "/srv/sampleapp",
      project_name: "sampleapp",
      compose_yaml: composeYaml,
      env_encrypted: encryptSecret(secretEnvironment),
      variables: [{ key: "API_TOKEN", secret: true }],
      credential_username: null,
      credential_secret_encrypted: null,
      host_id: hostId,
      status: "deploying"
    };
    const normalQuery = query.getMockImplementation()!;
    let candidateStackId = "";
    let candidateVersionId = "";
    query.mockImplementation(async (
      sql: string,
      values: unknown[] = []
    ) => {
      if (sql.includes("INSERT INTO compose_stacks")) {
        candidateStackId = String(values[0]);
      }
      if (sql.includes("INSERT INTO compose_stack_versions")) {
        candidateVersionId = String(values[0]);
      }
      if (sql.includes("SELECT * FROM deployment_analyses")) {
        return { rows: [analysis], rowCount: 1 };
      }
      if (
        sql.includes("SELECT id, host_id, project_name, compose_yaml")
        && sql.includes("FROM compose_stacks")
      ) {
        return {
          rows: [{
            id: candidateStackId,
            host_id: hostId,
            project_name: "sampleapp",
            compose_yaml: composeYaml,
            source_working_dir: "/srv/sampleapp",
            source_compose_path: "/srv/sampleapp/docker-compose.yml",
            deployment_source_id: null,
            current_version_id: candidateVersionId
          }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO deployment_sources")) {
        return {
          rows: [{ id: sourceId, source_type: "compose_upload" }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE deployment_analyses")
        && sql.includes("status = 'deployed'")
      ) {
        return {
          rows: [{ ...analysis, source_id: sourceId, status: "deployed" }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE compose_stacks")
        && sql.includes("deployment_source_id")
      ) {
        expect(values[2]).toBe(protectedEnvironment);
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes("UPDATE compose_stack_versions")
        && sql.includes("SET env = $2")
      ) {
        expect(values[1]).toBe(protectedEnvironment);
        return { rows: [], rowCount: 1 };
      }
      return normalQuery(sql, values);
    });
    const transactions: string[][] = [];
    const executionFence = {
      jobId: "00000000-0000-4000-8000-000000000099",
      attemptCount: 3,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: {
          query: (sql: string, values?: unknown[]) => Promise<unknown>
        }) => Promise<T>
      ) => {
        const statements: string[] = [];
        transactions.push(statements);
        return callback({
          query: async (sql: string, values: unknown[] = []) => {
            statements.push(sql);
            return query(sql, values);
          }
        });
      }
    };
    const { executeDockerAction } = await import("../src/services/docker.js");

    const result = await executeDockerAction({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "sampleapp",
        workingDir: "/srv/sampleapp",
        composePath: "docker-compose.yml"
      }
    }, executionFence as any, {
      deploymentAnalysisId: analysisId,
      deploymentSourceId: null
    } as any);

    expect(result).toMatchObject({
      stackId: candidateStackId,
      deploymentFinalization: {
        stackId: candidateStackId,
        replayed: false,
        source: { id: sourceId },
        analysis: { id: analysisId, status: "deployed" }
      }
    });
    const atomicTransaction = transactions.find((statements) =>
      statements.some((sql) => sql.includes("INSERT INTO compose_stacks"))
    );
    expect(atomicTransaction).toBeDefined();
    const stackIndex = atomicTransaction!.findIndex((sql) =>
      sql.includes("INSERT INTO compose_stacks")
    );
    const versionIndex = atomicTransaction!.findIndex((sql) =>
      sql.includes("INSERT INTO compose_stack_versions")
    );
    const sourceIndex = atomicTransaction!.findIndex((sql) =>
      sql.includes("INSERT INTO deployment_sources")
    );
    const analysisIndex = atomicTransaction!.findIndex((sql) =>
      sql.includes("UPDATE deployment_analyses")
      && sql.includes("status = 'deployed'")
    );
    expect(versionIndex).toBeGreaterThan(stackIndex);
    expect(sourceIndex).toBeGreaterThan(versionIndex);
    expect(analysisIndex).toBeGreaterThan(sourceIndex);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("result - $4::text")
    )).toBe(false);
  });

  it("rejects a Git deployment before persistence or Compose when the host file digest changed", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction(
      {
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName: "sampleapp",
          workingDir: "/srv/sampleapp",
          composePath: "docker-compose.yml"
        }
      },
      undefined,
      {
        expectedComposeSha256: "0".repeat(64),
        expectedGitRevision: "a".repeat(40),
        expectedGitBranch: "main"
      }
    )).rejects.toThrow("host Compose file changed after analysis");

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("docker compose")
    )).toBe(false);
  });

  it("rejects a Git deployment before Compose when the checkout revision changed", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");
    const expectedRevision = "a".repeat(40);
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("current=$(git rev-parse HEAD)")) {
        return sshOk(JSON.stringify({
          currentCommit: "b".repeat(40),
          latestCommit: "b".repeat(40),
          branch: "main",
          repositoryUrl: "https://git.example.test/acme/sampleapp.git"
        }));
      }
      return sshOk("");
    });

    await expect(executeDockerAction(
      {
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName: "sampleapp",
          workingDir: "/srv/sampleapp",
          composePath: "docker-compose.yml"
        }
      },
      undefined,
      {
        expectedComposeSha256: createHash("sha256").update(composeYaml).digest("hex"),
        expectedGitRevision: expectedRevision,
        expectedGitBranch: "main"
      }
    )).rejects.toThrow("host Git checkout changed after analysis");

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("docker compose")
    )).toBe(false);
  });

  it("uses the bound Git environment over SSH stdin without reading or persisting a stale host .env", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");
    const expectedRevision = "a".repeat(40);
    const environment = "APP_MODE=qualified\nDATABASE_PASSWORD=top-secret\n";
    const persistedEnvironment = "APP_MODE=qualified\nDATABASE_PASSWORD=\n";
    const gitComposeYaml = [
      "services:",
      "  app:",
      "    image: nginx:alpine",
      "    volumes:",
      "      - ./runtime:/runtime"
    ].join("\n");
    const executionFence = {
      jobId: "00000000-0000-4000-8000-000000000099",
      attemptCount: 1,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };
    readRemoteFile.mockImplementation(async (_ssh: unknown, remotePath: string) => {
      if (String(remotePath).endsWith(".env")) return "APP_MODE=stale\n";
      return gitComposeYaml;
    });
    runSshCommand.mockImplementation(async (
      _ssh: unknown,
      command: string
    ) => {
      if (command.includes("current=$(git rev-parse HEAD)")) {
        return sshOk(JSON.stringify({
          currentCommit: expectedRevision,
          latestCommit: expectedRevision,
          branch: "main",
          repositoryUrl: "https://git.example.test/acme/sampleapp.git"
        }));
      }
      if (command.includes("docker ps --all")
        || command.includes("docker image ls")
        || command.includes("docker network ls")
        || command.includes("docker volume ls")) {
        return sshOk("");
      }
      return sshOk("ok\n");
    });

    await executeDockerAction(
      {
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName: "sampleapp",
          workingDir: "/srv/sampleapp",
          composePath: "docker-compose.yml"
        }
      },
      executionFence,
      {
        expectedComposeSha256: createHash("sha256").update(gitComposeYaml).digest("hex"),
        expectedGitRevision: expectedRevision,
        expectedGitBranch: "main",
        expectedEnvironmentSha256: deploymentEnvironmentBinding(environment),
        environmentOverride: environment,
        persistedEnvironment
      }
    );

    expect(readRemoteFile.mock.calls.some((call) =>
      String(call[1]).endsWith(".env")
    )).toBe(false);
    const composeCall = runSshCommand.mock.calls.find((call) =>
      String(call[1]).includes("--env-file \"$COMPOSEBASTION_REMOTE_INPUT\"")
    );
    expect(composeCall?.[1]).toContain(
      "--env-file \"$COMPOSEBASTION_REMOTE_INPUT\""
    );
    expect(composeCall?.[1]).toContain("env -i");
    expect(composeCall?.[1]).toContain(
      "docker --host 'unix:///var/run/docker.sock' --config \"$HOME/.docker\" compose"
    );
    expect(composeCall?.[1]).not.toContain("DOCKER_HOST=");
    expect(composeCall?.[1]).not.toContain("top-secret");
    expect(composeCall?.[1]).toContain(
      'test -n "${COMPOSEBASTION_REMOTE_INPUT:-}"'
    );
    expect(composeCall?.[1]).toContain(
      'test ! -L "$COMPOSEBASTION_REMOTE_INPUT"'
    );
    expect(composeCall?.[1]).toContain(
      'test -f "$COMPOSEBASTION_REMOTE_INPUT"'
    );
    expect(composeCall?.[1]).toContain(
      'test "$(stat -c %a -- "$COMPOSEBASTION_REMOTE_INPUT")" = 600'
    );
    expect(composeCall?.[1]).toContain(
      `git rev-parse --verify HEAD^{commit})" = '${expectedRevision}'`
    );
    expect(composeCall?.[1]).toContain(
      "git --literal-pathspecs ls-files -- 'runtime'"
    );
    expect(composeCall?.[1]).toContain(
      "git status --porcelain=v1 --untracked-files=all --ignored=matching -- . ':(exclude,literal)runtime'"
    );
    expect(composeCall?.[1]).toContain(
      `sha256sum -- '/srv/sampleapp/docker-compose.yml'`
    );
    expect(composeCall?.[2]).toEqual({
      timeoutMs: 10 * 60_000,
      input: environment
    });
    const stackInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    );
    expect(stackInsert?.[1]?.[5]).toBe(persistedEnvironment);
    expect(decryptSecret(String(stackInsert?.[1]?.[6]))).toBe(environment);
    expect(stackInsert?.[1]?.[7]).toBe(
      deploymentEnvironmentBinding(environment)
    );
    const versionInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO compose_stack_versions")
    );
    expect(versionInsert?.[1]?.[4]).toBe(persistedEnvironment);
  });

  it("rejects a changed Git environment before persistence or Compose execution", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction(
      {
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName: "sampleapp",
          workingDir: "/srv/sampleapp",
          composePath: "docker-compose.yml"
        }
      },
      undefined,
      {
        expectedComposeSha256: createHash("sha256").update(composeYaml).digest("hex"),
        expectedGitRevision: "a".repeat(40),
        expectedGitBranch: "main",
        expectedEnvironmentSha256: "0".repeat(64),
        environmentOverride: "APP_MODE=qualified\n",
        persistedEnvironment: "APP_MODE=qualified\n"
      }
    )).rejects.toThrow("deployment environment changed after it was queued");

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("docker compose")
    )).toBe(false);
  });

  it("uses the encrypted library environment for later Git stack lifecycle actions", async () => {
    const sourceEnvironment = "APP_PASSWORD='qualification secret #1'";
    const revision = "b".repeat(40);
    const gitStack = {
      ...stackRow(),
      source_type: "git",
      deployment_source_id: "00000000-0000-4000-8000-000000000020",
      source_current_commit_sha: revision,
      source_environment_encrypted: encryptSecret(sourceEnvironment),
      source_environment_binding: deploymentEnvironmentBinding(sourceEnvironment),
      env: "APP_PASSWORD=''",
      compose_yaml: [
        "services:",
        "  app:",
        "    image: nginx:alpine",
        "    environment:",
        "      APP_PASSWORD: ${APP_PASSWORD:?required}",
        "    volumes:",
        "      - ./runtime:/runtime"
      ].join("\n")
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM compose_stacks")) {
        return { rows: [gitStack] };
      }
      if (sql.includes("SELECT data FROM resource_snapshots")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const fence = {
      assertActive: vi.fn(async () => undefined),
      withActiveLease: vi.fn(async (callback) => callback({
        query: (...args: unknown[]) => query(...args)
      }))
    };
    const { executeDockerAction } = await import("../src/services/docker.js");

    await executeDockerAction({
      type: "compose.stop",
      hostId,
      payload: { stackId: gitStack.id }
    }, fence as any);

    const lifecycleCall = runSshCommand.mock.calls.find((call) =>
      String(call[1]).includes("docker")
      && String(call[1]).includes("compose")
      && String(call[1]).includes(" stop")
    );
    expect(lifecycleCall?.[1]).toContain(
      "--env-file \"$COMPOSEBASTION_REMOTE_INPUT\""
    );
    expect(lifecycleCall?.[1]).toContain(
      `git rev-parse --verify HEAD^{commit})" = '${revision}'`
    );
    expect(lifecycleCall?.[1]).toContain(
      "git --literal-pathspecs ls-files -- 'runtime'"
    );
    expect(lifecycleCall?.[1]).toContain(
      "git status --porcelain=v1 --untracked-files=all --ignored=matching -- . ':(exclude,literal)runtime'"
    );
    expect(lifecycleCall?.[1]).not.toContain("qualification secret");
    expect(lifecycleCall?.[2]).toEqual({
      timeoutMs: 10 * 60_000,
      input: sourceEnvironment
    });
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
    statAgentRemoteFile.mockRejectedValue(new Error("Agent file access is limited to /tmp/composebastion"));
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
    })).rejects.toThrow("/tmp/composebastion");
    expect(writeAgentRemoteFile).not.toHaveBeenCalled();
  });
});
