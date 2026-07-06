import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/services/crypto.js";

const query = vi.fn();
const enqueueJob = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args)
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function repoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000123",
    name: "Private App",
    repository_url: "https://github.com/owner/private-app",
    owner: "owner",
    repo: "private-app",
    branch: "main",
    compose_path: "docker-compose.yml",
    project_name: "private-app",
    env: "",
    default_host_id: null,
    host_clone_url: null,
    host_clone_directory: null,
    github_token_encrypted: null,
    github_token_updated_at: null,
    github_token_checked_at: null,
    github_token_check_error: null,
    last_deployed_at: null,
    last_deployed_commit_sha: null,
    latest_commit_sha: null,
    update_checked_at: null,
    update_check_error: null,
    last_error: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides
  };
}

function mockSuccessfulGithubFetch(token = "github_pat_secret") {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(`Bearer ${token}`);
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.pathname === "/repos/owner/private-app") return jsonResponse({ private: true });
    if (url.pathname === "/repos/owner/private-app/commits/main") return jsonResponse({ sha: "abc123" });
    if (url.pathname === "/repos/owner/private-app/contents/docker-compose.yml") {
      return jsonResponse({ encoding: "base64", content: Buffer.from("services: {}\n").toString("base64") });
    }
    if (url.pathname.endsWith("/branches")) return jsonResponse([{ name: "main", commit: { sha: "abc123" } }]);
    if (url.pathname.endsWith("/tags")) return jsonResponse([{ name: "v1.0.0", commit: { sha: "abc123" } }]);
    if (url.pathname.endsWith("/releases")) return jsonResponse([{ tag_name: "v1.0.0", name: "Version 1.0.0", draft: false }]);
    return jsonResponse({ message: "not found" }, 404);
  });
}

describe("private GitHub repository credentials", () => {
  beforeEach(() => {
    query.mockReset();
    enqueueJob.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates and stores new repo tokens without returning the secret", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    query.mockImplementation(async (_sql: string, params: unknown[]) => ({
      rows: [repoRow({
        github_token_encrypted: params[12],
        host_clone_url: params[10],
        host_clone_directory: params[11],
        github_token_updated_at: new Date().toISOString(),
        github_token_checked_at: new Date().toISOString()
      })]
    }));
    const { createGithubRepository } = await import("../src/services/github.js");

    const repository = await createGithubRepository({
      name: "Private App",
      repositoryUrl: "https://github.com/owner/private-app",
      branch: "main",
      composePath: "docker-compose.yml",
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app",
      githubToken: "github_pat_secret"
    });

    expect(repository).toMatchObject({
      hasGithubToken: true,
      githubTokenStatus: "valid",
      githubTokenCheckError: null,
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app"
    });
    expect(JSON.stringify(query.mock.calls)).not.toContain("github_pat_secret");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("rejects invalid private repo tokens with least-privilege guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "not found" }, 404)));
    const { createGithubRepository } = await import("../src/services/github.js");

    await expect(createGithubRepository({
      name: "Private App",
      repositoryUrl: "https://github.com/owner/private-app",
      branch: "main",
      composePath: "docker-compose.yml",
      githubToken: "github_pat_secret"
    })).rejects.toThrow("read-only Contents access");
    expect(query).not.toHaveBeenCalled();
  });

  it("clears saved tokens explicitly", async () => {
    const saved = encryptSecret("github_pat_secret");
    query
      .mockResolvedValueOnce({ rows: [repoRow({ github_token_encrypted: saved })] })
      .mockResolvedValueOnce({ rows: [repoRow({ github_token_encrypted: null })] });
    const { updateGithubRepository } = await import("../src/services/github.js");

    const repository = await updateGithubRepository("00000000-0000-4000-8000-000000000123", {
      clearGithubToken: true
    });

    expect(repository).toMatchObject({
      hasGithubToken: false,
      githubTokenStatus: "none"
    });
    expect(query.mock.calls[1]?.[1]).toContain(true);
  });

  it("updates host clone defaults without requiring token validation", async () => {
    query
      .mockResolvedValueOnce({ rows: [repoRow()] })
      .mockResolvedValueOnce({ rows: [repoRow({
        host_clone_url: "git@github-private-app:owner/private-app.git",
        host_clone_directory: "/srv/apps/private-app"
      })] });
    const { updateGithubRepository } = await import("../src/services/github.js");

    const repository = await updateGithubRepository("00000000-0000-4000-8000-000000000123", {
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app"
    });

    expect(repository).toMatchObject({
      hasGithubToken: false,
      githubTokenStatus: "none",
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app"
    });
    expect(query.mock.calls).toHaveLength(2);
  });

  it("enqueues tracked host clone deploy jobs with repository metadata", async () => {
    query
      .mockResolvedValueOnce({ rows: [repoRow({
        host_clone_url: "git@github-private-app:owner/private-app.git",
        host_clone_directory: "/srv/apps/private-app"
      })] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueJob.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000777",
      type: "git.cloneDeploy",
      status: "queued"
    });
    const { deployGithubRepository } = await import("../src/services/github.js");

    const result = await deployGithubRepository("00000000-0000-4000-8000-000000000123", {
      mode: "host_clone",
      hostId: "00000000-0000-4000-8000-000000000001",
      branch: "main",
      projectName: "private-app",
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app"
    });

    expect(result).toMatchObject({ mode: "host_clone", branch: "main" });
    expect(enqueueJob).toHaveBeenCalledWith({
      type: "git.cloneDeploy",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        repositoryId: "00000000-0000-4000-8000-000000000123",
        repositoryUrl: "git@github-private-app:owner/private-app.git",
        directory: "/srv/apps/private-app",
        branch: "main",
        composePath: "docker-compose.yml",
        projectName: "private-app"
      }
    }, undefined);
  });

  it("reuses stored tokens for GitHub version discovery by URL", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    query.mockResolvedValue({ rows: [repoRow({ github_token_encrypted: encryptSecret("github_pat_secret") })] });
    const { listGithubVersionsForUrlWithStoredCredentials } = await import("../src/services/github.js");

    const versions = await listGithubVersionsForUrlWithStoredCredentials("https://github.com/owner/private-app", {
      selectedRef: "main",
      currentCommitSha: "abc123"
    });

    expect(versions.options.map((option) => `${option.kind}:${option.ref}`)).toEqual([
      "branch:main",
      "tag:v1.0.0",
      "release:v1.0.0"
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
