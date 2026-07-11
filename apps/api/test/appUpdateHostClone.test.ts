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

  it("uses git pull plus deploy path instead of API deploy for clone-built tracked repos", async () => {
    const { updateApp } = await import("../src/services/apps.js");

    await updateApp(`git:${repoId}`, "00000000-0000-4000-8000-000000000222");

    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob.mock.calls[0]?.[0]).toMatchObject({
      type: "git.pull",
      hostId,
      payload: { directory: "/srv/apps/private-app", branch: "main" }
    });
    expect(enqueueJob.mock.calls[1]?.[0]).toMatchObject({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "private-app",
        workingDir: "/srv/apps/private-app",
        composePath: "docker-compose.yml"
      }
    });
    expect(notifyJobQueued).toHaveBeenCalledTimes(2);
  });

  it("does not publish wakeups when a later insert aborts the batch transaction", async () => {
    enqueueJob
      .mockResolvedValueOnce({ id: "first-job", status: "queued", type: "git.pull" })
      .mockRejectedValueOnce(new Error("second insert failed"));
    const { updateApp } = await import("../src/services/apps.js");

    await expect(updateApp(`git:${repoId}`)).rejects.toThrow("second insert failed");
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });
});
