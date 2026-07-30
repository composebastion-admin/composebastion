import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

const { encryptConfigPayload } = await import("../src/services/crypto.js");
const { importConfigBackup } = await import("../src/services/configBackup.js");

const passphrase = "mutation-admission-passphrase";
const hostId = "10000000-0000-4000-8000-000000000001";
const registryId = "20000000-0000-4000-8000-000000000002";
const repositoryId = "30000000-0000-4000-8000-000000000003";
const stackId = "40000000-0000-4000-8000-000000000004";
const sourceId = "50000000-0000-4000-8000-000000000005";
const jobId = "60000000-0000-4000-8000-000000000006";

function payload(overrides: Record<string, unknown>) {
  return {
    app: "ComposeBastion",
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: "1.2.0-beta.1",
    exportedAt: "2026-07-30T12:00:00.000Z",
    hosts: [],
    composeStacks: [],
    registries: [],
    notificationChannels: [],
    alertRules: [],
    favoriteImages: [],
    githubRepositories: [],
    deploymentSources: [],
    appSourceLinks: [],
    backupTargets: [],
    ...overrides
  };
}

function encrypted(overrides: Record<string, unknown>) {
  return encryptConfigPayload(payload(overrides), passphrase) as unknown as Record<string, unknown>;
}

function repositoryInput(id = repositoryId, owner = "example", repo = "app") {
  return {
    id,
    name: `${owner}/${repo}`,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
    branch: "main",
    composePath: "compose.yml",
    projectName: `${owner}-${repo}`
  };
}

function stackInput(id = stackId, projectName = "guarded-app") {
  return {
    id,
    hostId,
    name: projectName,
    projectName,
    composeYaml: "services:\n  app:\n    image: registry.example.test/team/app:latest\n"
  };
}

function noWrites() {
  expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
    /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(String(sql))
  )).toBe(false);
}

describe("configuration import live-dependency admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.transactionQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (
      callback: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => callback({ query: mocks.transactionQuery }));
  });

  it("blocks a repository binding before any imported record is written", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (
        sql.includes("SELECT id")
        && sql.includes("FROM github_repositories")
        && sql.includes("owner =")
      ) {
        return { rows: [{ id: repositoryId }] };
      }
      if (sql.includes("SELECT * FROM github_repositories") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: repositoryId }] };
      }
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("repository_id")) {
        return { rows: [{ operation_job_id: jobId }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(importConfigBackup(
      encrypted({ githubRepositories: [repositoryInput()] }),
      passphrase
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
    noWrites();
  });

  it("blocks an unreconciled Compose outcome before any imported record is written", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id") && sql.includes("FROM compose_stacks")) {
        return { rows: [{ id: stackId }] };
      }
      if (sql.includes("SELECT * FROM compose_stacks") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: stackId, host_id: hostId }] };
      }
      if (sql.includes("FROM operation_jobs") && sql.includes("compose.deploy")) {
        return {
          rows: [{
            id: jobId,
            status: "failed",
            error: "REMOTE_OUTCOME_UNKNOWN: command timed out",
            result: null
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(importConfigBackup(
      encrypted({ composeStacks: [stackInput()] }),
      passphrase
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
    noWrites();
  });

  it("blocks host credential replacement while any host operation is active", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM docker_hosts") && sql.includes("deleted_at IS NULL")) {
        return {
          rows: [{
            id: hostId,
            name: "Existing host",
            hostname: "host.example.test",
            username: "docker",
            port: 22
          }]
        };
      }
      if (sql.includes("FROM docker_hosts") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: hostId,
            deleted_at: null,
            name: "Existing host",
            hostname: "host.example.test"
          }]
        };
      }
      if (sql.includes("FROM operation_jobs AS jobs") && values?.[0] === hostId) {
        return {
          rows: [{
            id: jobId,
            status: "running",
            error: null,
            result: null
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(importConfigBackup(encrypted({
      hosts: [{
        id: hostId,
        name: "Existing host",
        hostname: "host.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        dockerSocketPath: "/var/run/docker.sock",
        tags: [],
        secrets: { sshPassword: "replacement-password" }
      }]
    }), passphrase)).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
    noWrites();
  });

  it("blocks registry credential replacement for active login and deployment consumers", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT id FROM registries WHERE id = $1") {
        return { rows: [{ id: registryId }] };
      }
      if (sql.includes("SELECT * FROM registries") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: registryId,
            url: "https://registry.example.test",
            insecure: false
          }]
        };
      }
      if (sql.includes("type = 'registry.login'")) {
        return {
          rows: [{ id: jobId, status: "queued", error: null, result: null }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(importConfigBackup(encrypted({
      registries: [{
        id: registryId,
        name: "Private registry",
        url: "https://registry.example.test",
        username: "operator",
        password: "replacement",
        insecure: false
      }]
    }), passphrase)).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
    noWrites();
  });

  it("blocks imported deployment-source changes while a deployable analysis owns its snapshot", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT id FROM deployment_sources WHERE id = $1") {
        return { rows: [{ id: sourceId }] };
      }
      if (sql.includes("SELECT id FROM deployment_sources") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: sourceId }] };
      }
      if (sql.includes("FROM deployment_analyses AS analyses")) {
        return {
          rows: [{
            id: "70000000-0000-4000-8000-000000000007",
            status: "ready",
            operation_job_id: null
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(importConfigBackup(encrypted({
      deploymentSources: [{
        id: sourceId,
        sourceType: "image",
        name: "Library image",
        sourceLocator: "nginx:alpine",
        projectName: "library-image"
      }]
    }), passphrase)).rejects.toMatchObject({
      statusCode: 409,
      analysisId: "70000000-0000-4000-8000-000000000007"
    });
    noWrites();
  });

  it("takes deterministic target locks and still creates unrelated new records", async () => {
    const secondHostId = "11000000-0000-4000-8000-000000000011";
    const secondRegistryId = "21000000-0000-4000-8000-000000000012";
    const secondRepositoryId = "31000000-0000-4000-8000-000000000013";
    const secondStackId = "41000000-0000-4000-8000-000000000014";
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO")) return { rows: [{ id: "created" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await importConfigBackup(encrypted({
      registries: [
        { id: secondRegistryId, name: "Z", url: "https://z.registry.test", insecure: false },
        { id: registryId, name: "A", url: "https://a.registry.test", insecure: false }
      ],
      githubRepositories: [
        repositoryInput(secondRepositoryId, "zeta", "app"),
        repositoryInput(repositoryId, "alpha", "app")
      ],
      composeStacks: [
        { ...stackInput(secondStackId, "zeta"), hostId: secondHostId },
        stackInput(stackId, "alpha")
      ],
      deploymentSources: [{
        id: sourceId,
        sourceType: "image",
        name: "New image",
        sourceLocator: "nginx:alpine",
        projectName: "new-image"
      }]
    }), passphrase);

    expect(result.imported).toMatchObject({
      registries: 2,
      githubRepositories: 2,
      composeStacks: 2,
      deploymentSources: 1
    });
    const identityKeys = mocks.transactionQuery.mock.calls
      .filter(([sql, values]) =>
        String(sql).includes("pg_advisory_xact_lock")
        && typeof values?.[0] === "string"
        && (
          values[0].startsWith("github-repository:")
          || values[0].startsWith("compose-stack-identity:")
        )
      )
      .map(([, values]) => values[0]);
    expect(identityKeys).toEqual([...identityKeys].sort());
  });

  it("runs the import audit callback before the transaction can return", async () => {
    const auditFailure = new Error("audit insert failed");
    const onImported = vi.fn(async (
      client: { query: typeof mocks.transactionQuery }
    ) => {
      expect(client.query).toBe(mocks.transactionQuery);
      throw auditFailure;
    });

    await expect(importConfigBackup(
      encrypted({}),
      passphrase,
      onImported
    )).rejects.toBe(auditFailure);

    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.transactionQuery }),
      expect.objectContaining({
        imported: expect.objectContaining({
          hosts: 0,
          composeStacks: 0,
          registries: 0
        })
      })
    );
  });
});
