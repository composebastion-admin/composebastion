import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const enqueueJob = vi.fn();
const notifyJobQueued = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query })
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
  enqueueJobInTransaction: (_client: unknown, ...args: unknown[]) => enqueueJob(...args),
  notifyJobQueued: (...args: unknown[]) => notifyJobQueued(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: vi.fn(),
  listImageUpdateChecks: vi.fn(async () => [])
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const repoId = "00000000-0000-4000-8000-000000000123";
const stackId = "00000000-0000-4000-8000-000000000999";
const now = new Date(0).toISOString();

const stackRow = {
  id: stackId,
  host_id: hostId,
  name: "Private App",
  project_name: "private-app",
  compose_yaml: "services:\n  app:\n    build: .\n",
  env: "",
  status: "deployed",
  source_type: "git",
  source_repository_url: "https://github.com/owner/private-app",
  source_branch: "main",
  source_working_dir: "/srv/apps/private-app",
  source_compose_path: "docker-compose.yml",
  source_current_commit_sha: "abc123",
  source_latest_commit_sha: "def456",
  source_checked_at: now,
  source_check_error: null,
  created_at: now,
  updated_at: now
};

const repoRow = {
  id: repoId,
  name: "Private App",
  repository_url: "https://github.com/owner/private-app",
  owner: "owner",
  repo: "private-app",
  branch: "main",
  compose_path: "docker-compose.yml",
  project_name: "private-app",
  env: "",
  default_host_id: hostId,
  host_clone_url: "git@github-private-app:owner/private-app.git",
  host_clone_directory: "/srv/apps/private-app",
  github_token_encrypted: null,
  github_token_checked_at: null,
  github_token_check_error: null,
  last_deployed_at: now,
  last_deployed_commit_sha: "abc123",
  latest_commit_sha: "def456",
  update_checked_at: now,
  update_check_error: null,
  last_error: null,
  created_at: now,
  updated_at: now
};

describe("app updates for tracked GitHub host clones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueJob.mockImplementation(async (job) => ({ id: "queued-job", status: "queued", ...job }));
    notifyJobQueued.mockResolvedValue(undefined);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) return { rows: [{ id: hostId, name: "Host", hostname: "host.local" }] };
      if (sql.includes("FROM resource_snapshots")) return { rows: [] };
      if (sql.includes("FROM compose_stacks WHERE id = $1")) return { rows: [stackRow] };
      if (sql.includes("FROM compose_stacks")) return { rows: [stackRow] };
      if (sql.includes("FROM github_repositories")) return { rows: [repoRow] };
      if (sql.includes("FROM app_source_links")) return { rows: [] };
      return { rows: [] };
    });
  });

  it("uses one fenced pull-and-deploy job without rewriting the configured Git origin", async () => {
    const { updateApp } = await import("../src/services/apps.js");

    await updateApp(`git:${repoId}`, "00000000-0000-4000-8000-000000000222");

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob.mock.calls[0]?.[0]).toMatchObject({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "private-app",
        workingDir: "/srv/apps/private-app",
        composePath: "docker-compose.yml",
        gitPullBeforeDeploy: true,
        branch: "main"
      }
    });
    expect(notifyJobQueued).toHaveBeenCalledTimes(1);
  });

  it("updates a linked Git checkout when no repository URL is stored", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) return { rows: [{ id: hostId, name: "Host", hostname: "host.local" }] };
      if (sql.includes("FROM resource_snapshots")) return { rows: [] };
      if (sql.includes("FROM compose_stacks")) {
        return { rows: [{ ...stackRow, source_repository_url: null }] };
      }
      if (sql.includes("FROM github_repositories")) return { rows: [repoRow] };
      if (sql.includes("FROM app_source_links")) return { rows: [] };
      return { rows: [] };
    });
    const { updateApp } = await import("../src/services/apps.js");

    await expect(updateApp(`git:${repoId}`)).resolves.toMatchObject({
      jobs: [expect.objectContaining({ type: "compose.deployPath" })]
    });
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compose.deployPath",
        payload: expect.objectContaining({
          workingDir: "/srv/apps/private-app",
          gitPullBeforeDeploy: true
        })
      }),
      undefined
    );
  });

  it("does not publish wakeups when the composite insert aborts", async () => {
    enqueueJob.mockRejectedValueOnce(new Error("insert failed"));
    const { updateApp } = await import("../src/services/apps.js");

    await expect(updateApp(`git:${repoId}`)).rejects.toThrow("insert failed");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("does not publish any app update job when its transactional audit fails", async () => {
    const auditFailure = new Error("audit insert failed");
    const onQueued = vi.fn(async () => {
      throw auditFailure;
    });
    const { updateApp } = await import("../src/services/apps.js");

    await expect(updateApp(
      `git:${repoId}`,
      "00000000-0000-4000-8000-000000000222",
      onQueued
    )).rejects.toBe(auditFailure);

    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      {
        jobs: [
          expect.objectContaining({ type: "compose.deployPath" })
        ]
      }
    );
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("does not publish a standalone container update when its transactional audit fails", async () => {
    const resourceId = "00000000-0000-4000-8000-000000000777";
    const containerId = "container-external-id";
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId, name: "Host", hostname: "host.local" }] };
      }
      if (sql.includes("FROM resource_snapshots")) {
        return {
          rows: [{
            id: resourceId,
            host_id: hostId,
            kind: "container",
            external_id: containerId,
            name: "standalone",
            data: {
              Names: "/standalone",
              Image: "nginx:alpine",
              State: "running"
            },
            updated_at: now
          }]
        };
      }
      if (sql.includes("FROM compose_stacks")) return { rows: [] };
      if (sql.includes("FROM github_repositories")) return { rows: [] };
      if (sql.includes("FROM app_source_links")) return { rows: [] };
      return { rows: [] };
    });
    const auditFailure = new Error("audit insert failed");
    const { updateApp } = await import("../src/services/apps.js");

    await expect(updateApp(
      `container:${resourceId}`,
      "00000000-0000-4000-8000-000000000222",
      async () => {
        throw auditFailure;
      }
    )).rejects.toBe(auditFailure);

    expect(enqueueJob).toHaveBeenCalledWith(
      {
        type: "container.update",
        hostId,
        payload: {
          containerId,
          targetImage: "nginx:alpine"
        }
      },
      "00000000-0000-4000-8000-000000000222"
    );
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });
});
