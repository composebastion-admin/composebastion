import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  lockComposeStackForMutation: vi.fn(),
  lockGithubRepositoryForMutation: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn(),
  recordStackVersionInTransaction: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: async (
    callback: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
  ) => callback({ query: mocks.transactionQuery })
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: vi.fn(),
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  lockComposeStackForMutation: (...args: unknown[]) =>
    mocks.lockComposeStackForMutation(...args),
  lockGithubRepositoryForMutation: (...args: unknown[]) =>
    mocks.lockGithubRepositoryForMutation(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: vi.fn(),
  listImageUpdateChecks: vi.fn(async () => [])
}));

vi.mock("../src/services/stackVersions.js", () => ({
  recordStackVersionInTransaction: (...args: unknown[]) =>
    mocks.recordStackVersionInTransaction(...args)
}));

const { renameApp, selectAppGithubVersion } = await import("../src/services/apps.js");
const {
  deployCatalogTemplate,
  saveCustomCatalogTemplate
} = await import("../src/services/catalog.js");

const hostId = "10000000-0000-4000-8000-000000000001";
const repositoryId = "20000000-0000-4000-8000-000000000002";
const stackId = "30000000-0000-4000-8000-000000000003";
const jobId = "40000000-0000-4000-8000-000000000004";
const resourceId = "50000000-0000-4000-8000-000000000005";
const sourceLinkId = "60000000-0000-4000-8000-000000000006";
const now = new Date("2026-07-30T12:00:00.000Z");

const stackRow = {
  id: stackId,
  host_id: hostId,
  name: "Guarded app",
  project_name: "guarded-app",
  compose_yaml: "services:\n  app:\n    image: nginx:alpine\n",
  env: "",
  status: "deployed",
  source_type: "github",
  source_repository_url: "https://github.com/example/guarded-app",
  source_branch: "main",
  source_working_dir: null,
  source_compose_path: "compose.yml",
  source_current_commit_sha: "a".repeat(40),
  source_latest_commit_sha: "a".repeat(40),
  source_checked_at: now,
  source_check_error: null,
  deployment_source_id: null,
  domains: [],
  exposed_service: null,
  exposed_port: null,
  tls_desired: false,
  update_policy_enabled: false,
  update_policy_channel: null,
  created_at: now,
  updated_at: now
};

const repositoryRow = {
  id: repositoryId,
  name: "Guarded app",
  repository_url: "https://github.com/example/guarded-app",
  owner: "example",
  repo: "guarded-app",
  branch: "main",
  compose_path: "compose.yml",
  project_name: "guarded-app",
  env: "",
  default_host_id: hostId,
  host_clone_url: null,
  host_clone_directory: null,
  github_token_encrypted: null,
  github_token_checked_at: null,
  github_token_check_error: null,
  last_deployed_at: now,
  last_deployed_commit_sha: "a".repeat(40),
  latest_commit_sha: "a".repeat(40),
  update_checked_at: now,
  update_check_error: null,
  last_error: null,
  created_at: now,
  updated_at: now
};

function installAppInventory() {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM docker_hosts")) {
      return { rows: [{ id: hostId, name: "Qualification host", hostname: "host.test" }] };
    }
    if (sql.includes("FROM resource_snapshots")) return { rows: [] };
    if (sql.includes("FROM compose_stacks")) return { rows: [stackRow] };
    if (sql.includes("FROM github_repositories")) return { rows: [repositoryRow] };
    if (sql.includes("FROM app_source_links")) return { rows: [] };
    return { rows: [] };
  });
}

function admissionError(kind: "active" | "ambiguous") {
  return Object.assign(
    new Error(kind === "active"
      ? "This target cannot be changed while a remote job is running."
      : "This target cannot be changed until its unknown outcome is authoritatively reconciled."),
    { statusCode: 409, activeJobId: jobId }
  );
}

describe("app mutation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAppInventory();
    mocks.lockGithubRepositoryForMutation.mockResolvedValue(repositoryRow);
    mocks.lockComposeStackForMutation.mockResolvedValue(stackRow);
    mocks.transactionQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("rejects version selection before any write while a repository deployment is active", async () => {
    mocks.lockGithubRepositoryForMutation.mockRejectedValue(admissionError("active"));

    await expect(selectAppGithubVersion(`git:${repositoryId}`, { ref: "release" }))
      .rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });

    expect(mocks.lockGithubRepositoryForMutation).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.transactionQuery }),
      repositoryId
    );
    expect(mocks.lockComposeStackForMutation).not.toHaveBeenCalled();
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      /^\s*UPDATE\b/.test(String(sql))
    )).toBe(false);
  });

  it("rejects both version selection and rename before writes for an unreconciled stack outcome", async () => {
    mocks.lockComposeStackForMutation.mockRejectedValue(admissionError("ambiguous"));

    await expect(selectAppGithubVersion(`git:${repositoryId}`, { ref: "release" }))
      .rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
    await expect(renameApp(`git:${repositoryId}`, { name: "Renamed" }))
      .rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });

    expect(mocks.lockGithubRepositoryForMutation).toHaveBeenCalledTimes(2);
    expect(mocks.lockComposeStackForMutation).toHaveBeenCalledTimes(2);
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      /^\s*UPDATE\b/.test(String(sql))
    )).toBe(false);
  });

  it("locks repository then stack and commits the related version fields together", async () => {
    const order: string[] = [];
    mocks.lockGithubRepositoryForMutation.mockImplementation(async () => {
      order.push("repository");
      return repositoryRow;
    });
    mocks.lockComposeStackForMutation.mockImplementation(async () => {
      order.push("stack");
      return stackRow;
    });
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE github_repositories")) order.push("repository-update");
      if (sql.includes("UPDATE compose_stacks")) order.push("stack-update");
      return { rows: [], rowCount: 1 };
    });

    await expect(selectAppGithubVersion(`git:${repositoryId}`, { ref: "release" }))
      .resolves.toMatchObject({ app: expect.any(Object) });

    expect(order).toEqual([
      "repository",
      "stack",
      "repository-update",
      "stack-update"
    ]);
  });

  it("rejects a stale source-link identity before renaming a standalone container", async () => {
    const externalId = "container-external-id";
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId, name: "Qualification host", hostname: "host.test" }] };
      }
      if (sql.includes("FROM resource_snapshots")) {
        return {
          rows: [{
            id: resourceId,
            host_id: hostId,
            kind: "container",
            external_id: externalId,
            name: "standalone",
            data: { Names: "/standalone", Image: "nginx:alpine", State: "running" },
            updated_at: now
          }]
        };
      }
      if (sql.includes("FROM compose_stacks")) return { rows: [] };
      if (sql.includes("FROM github_repositories")) return { rows: [] };
      if (sql.includes("FROM app_source_links")) {
        return {
          rows: [{
            id: sourceLinkId,
            host_id: hostId,
            container_external_id: externalId,
            source_type: "image",
            name: "Standalone",
            image_reference: "nginx:alpine",
            updated_at: now
          }]
        };
      }
      return { rows: [] };
    });
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM app_source_links")) {
        return {
          rows: [{
            id: sourceLinkId,
            host_id: hostId,
            container_external_id: "different-container"
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(renameApp(`container:${resourceId}`, { name: "Renamed" }))
      .rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Refresh and try again")
      });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      /^\s*(?:INSERT|UPDATE|DELETE)\b/.test(String(sql))
    )).toBe(false);
  });
});

describe("catalog deployment admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id") && sql.includes("FROM compose_stacks")) {
        return { rows: [{ id: stackId }] };
      }
      if (sql.includes("UPDATE compose_stacks")) return { rows: [stackRow], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mocks.lockComposeStackForMutation.mockResolvedValue(stackRow);
    mocks.recordStackVersionInTransaction.mockResolvedValue({ id: "version" });
    mocks.enqueueJobInTransaction.mockResolvedValue({
      id: jobId,
      type: "compose.deploy",
      hostId,
      status: "queued"
    });
    mocks.notifyJobQueued.mockResolvedValue(undefined);
  });

  it.each(["active", "ambiguous"] as const)(
    "does not overwrite a catalog target with an %s remote operation",
    async (kind) => {
      mocks.lockComposeStackForMutation.mockRejectedValue(admissionError(kind));

      await expect(deployCatalogTemplate({
        templateId: "nginx",
        hostId,
        projectName: "guarded-app"
      })).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });

      expect(mocks.transactionQuery.mock.calls[0]?.[0]).toContain(
        "pg_advisory_xact_lock"
      );
      expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE compose_stacks")
        || String(sql).includes("INSERT INTO compose_stacks")
      )).toBe(false);
      expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
      expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
    }
  );

  it("does not publish or return a catalog deployment when its transactional audit fails", async () => {
    const auditFailure = new Error("audit insert failed");
    const onQueued = vi.fn(async () => {
      throw auditFailure;
    });

    await expect(deployCatalogTemplate({
      templateId: "nginx",
      hostId,
      projectName: "guarded-app"
    }, "user-1", onQueued)).rejects.toBe(auditFailure);

    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.transactionQuery }),
      expect.objectContaining({
        stack: expect.objectContaining({ id: stackId }),
        job: expect.objectContaining({ id: jobId }),
        templateId: "nginx"
      })
    );
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });
});

describe("custom catalog mutation audit admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the required audit callback on the catalog transaction client", async () => {
    const auditFailure = new Error("audit insert failed");
    mocks.transactionQuery.mockResolvedValueOnce({
      rows: [{
        id: "atomic-template",
        name: "Atomic template",
        description: "Transaction callback coverage",
        category: "utility",
        compose_yaml: "services:\n  app:\n    image: nginx:alpine\n",
        default_env: {},
        suggested_volumes: [],
        suggested_ports: [],
        docs_url: null
      }]
    });
    const onChanged = vi.fn(async (client: { query: typeof mocks.transactionQuery }) => {
      expect(client.query).toBe(mocks.transactionQuery);
      throw auditFailure;
    });

    await expect(saveCustomCatalogTemplate({
      id: "atomic-template",
      name: "Atomic template",
      description: "Transaction callback coverage",
      category: "utility",
      composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
      defaultEnv: {},
      suggestedVolumes: [],
      suggestedPorts: []
    }, null, onChanged)).rejects.toBe(auditFailure);

    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.transactionQuery }),
      expect.objectContaining({ id: "atomic-template", source: "custom" })
    );
  });
});
