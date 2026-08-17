import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/services/crypto.js";

const query = vi.fn();
const enqueueJob = vi.fn();
const notifyJobQueued = vi.fn();
const githubCommitSha = "a".repeat(40);
const githubComposeYaml = "services: {}\n";
const githubComposeSha256 = createHash("sha256")
  .update(githubComposeYaml, "utf8")
  .digest("hex");

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query })
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (_client: unknown, ...args: unknown[]) => enqueueJob(...args),
  lockComposeStackForMutation: async (client: { query: typeof query }, stackId: string) => {
    const selected = await client.query("SELECT * FROM compose_stacks WHERE id = $1 FOR UPDATE", [stackId]);
    return selected.rows[0] ?? null;
  },
  lockGithubRepositoryForMutation: async (client: { query: typeof query }, repositoryId: string) => {
    const selected = await client.query("SELECT * FROM github_repositories WHERE id = $1 FOR UPDATE", [repositoryId]);
    return selected.rows[0] ?? null;
  },
  notifyJobQueued: (...args: unknown[]) => notifyJobQueued(...args)
}));

vi.mock("../src/services/stackVersions.js", () => ({
  recordStackVersionInTransaction: vi.fn(async () => ({ id: "version" }))
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
    if (url.pathname === "/repos/owner/private-app/commits/main") return jsonResponse({ sha: githubCommitSha });
    if (url.pathname === "/repos/owner/private-app/contents/docker-compose.yml") {
      return jsonResponse({ encoding: "base64", content: Buffer.from(githubComposeYaml).toString("base64") });
    }
    if (url.pathname.endsWith("/branches")) return jsonResponse([{ name: "main", commit: { sha: githubCommitSha } }]);
    if (url.pathname.endsWith("/tags")) return jsonResponse([{ name: "v1.0.0", commit: { sha: githubCommitSha } }]);
    if (url.pathname.endsWith("/releases")) return jsonResponse([{ tag_name: "v1.0.0", name: "Version 1.0.0", draft: false }]);
    return jsonResponse({ message: "not found" }, 404);
  });
}

describe("private GitHub repository credentials", () => {
  beforeEach(() => {
    query.mockReset();
    enqueueJob.mockReset();
    notifyJobQueued.mockReset();
    notifyJobQueued.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates and stores new repo tokens without returning the secret", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT id") && sql.includes("owner = $1")) return { rows: [] };
      return {
        rows: [repoRow({
          github_token_encrypted: params[12],
          host_clone_url: params[10],
          host_clone_directory: params[11],
          github_token_updated_at: new Date().toISOString(),
          github_token_checked_at: new Date().toISOString()
        })]
      };
    });
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

  it("runs repository persistence and its audit callback on one transaction client", async () => {
    const auditFailure = new Error("audit insert failed");
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT id") && sql.includes("owner = $1")) return { rows: [] };
      return { rows: [repoRow()] };
    });
    const onChanged = vi.fn(async (client: { query: typeof query }) => {
      expect(client.query).toBe(query);
      throw auditFailure;
    });
    const { createGithubRepository } = await import("../src/services/github.js");

    await expect(createGithubRepository({
      name: "Private App",
      repositoryUrl: "https://github.com/owner/private-app",
      branch: "main",
      composePath: "docker-compose.yml"
    }, onChanged)).rejects.toBe(auditFailure);

    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000123" })
    );
  });

  it("fails closed before decrypting or fetching when the stored-access intent audit fails", async () => {
    const saved = encryptSecret("github_pat_secret");
    query.mockResolvedValueOnce({
      rows: [repoRow({ github_token_encrypted: saved })]
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const auditFailure = new Error("audit insert failed");
    const beforeAccess = vi.fn(async () => {
      throw auditFailure;
    });
    const { testGithubRepositoryStoredAccess } = await import(
      "../src/services/github.js"
    );

    await expect(testGithubRepositoryStoredAccess(
      "00000000-0000-4000-8000-000000000123",
      undefined,
      beforeAccess
    )).rejects.toBe(auditFailure);

    expect(beforeAccess).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000123"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
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
    expect(query.mock.calls[2]?.[1]).toContain(true);
  });

  it("updates host clone defaults without requiring token validation", async () => {
    query
      .mockResolvedValueOnce({ rows: [repoRow()] })
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
    expect(query.mock.calls).toHaveLength(3);
  });

  it("rejects plaintext Git URL credentials before GitHub persistence or access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const {
      createGithubRepository,
      listGithubBranchesForUrl,
      testGithubRepositoryAccess,
      updateGithubRepository
    } = await import("../src/services/github.js");

    await expect(createGithubRepository({
      name: "Unsafe repository",
      repositoryUrl: "https://git-user:git-secret@github.com/owner/private-app?token=git-secret"
    })).rejects.toThrow();
    await expect(updateGithubRepository(
      "00000000-0000-4000-8000-000000000123",
      { hostCloneUrl: "ssh://git:git-secret@github.com/owner/private-app.git" }
    )).rejects.toThrow();
    await expect(listGithubBranchesForUrl(
      "https://github.com/owner/private-app?token=git-secret"
    )).rejects.toThrow();
    await expect(testGithubRepositoryAccess({
      repositoryUrl: "https://git-user:git-secret@github.com/owner/private-app",
      branch: "main",
      composePath: "docker-compose.yml"
    })).rejects.toThrow();

    expect(query).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes legacy GitHub and host clone URL fields on reads", async () => {
    const { mapGithubRepository } = await import("../src/services/github.js");
    const mapped = mapGithubRepository(repoRow({
      repository_url: "https://git-user:git-secret@github.com/owner/private-app?token=git-secret",
      host_clone_url: "ssh://git:git-secret@github.com/owner/private-app.git#git-secret",
      last_error: "Clone failed for https://git-user:git-secret@github.com/owner/private-app?token=git-secret"
    }));

    expect(mapped).toMatchObject({
      repositoryUrl: "https://github.com/owner/private-app",
      hostCloneUrl: "ssh://git@github.com/owner/private-app.git",
      lastError: "Clone failed for https://github.com/owner/private-app"
    });
    expect(JSON.stringify(mapped)).not.toContain("git-secret");
  });

  it("enqueues tracked host clone deploy jobs with repository metadata", async () => {
    vi.stubGlobal("fetch", mockSuccessfulGithubFetch());
    query
      .mockResolvedValueOnce({ rows: [repoRow({
        host_clone_url: "git@github-private-app:owner/private-app.git",
        host_clone_directory: "/srv/apps/private-app",
        github_token_encrypted: encryptSecret("github_pat_secret")
      })] })
      .mockResolvedValueOnce({ rows: [repoRow({
        host_clone_url: "git@github-private-app:owner/private-app.git",
        host_clone_directory: "/srv/apps/private-app",
        github_token_encrypted: encryptSecret("github_pat_secret")
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
      hostCloneDirectory: "/srv/apps/private-app",
      env: "SECRET_TOKEN=host-clone-secret"
    });

    expect(result).toMatchObject({
      mode: "host_clone",
      branch: "main",
      sourceCommitSha: githubCommitSha,
      composeSha256: githubComposeSha256
    });
    expect(enqueueJob).toHaveBeenCalledWith({
      type: "git.cloneDeploy",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        repositoryId: "00000000-0000-4000-8000-000000000123",
        repositoryUrl: "git@github-private-app:owner/private-app.git",
        directory: "/srv/apps/private-app",
        branch: "main",
        composePath: "docker-compose.yml",
        projectName: "private-app",
        sourceCommitSha: githubCommitSha,
        composeSha256: githubComposeSha256
      }
    }, undefined);
    const bindingInsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO github_clone_deployment_jobs")
    );
    expect(bindingInsert?.[1]).toEqual(expect.arrayContaining([
      githubCommitSha,
      githubComposeYaml,
      githubComposeSha256,
      "private-app",
      "/srv/apps/private-app"
    ]));
    expect(String(bindingInsert?.[1]?.[12])).not.toContain(
      "host-clone-secret"
    );
    expect(JSON.stringify(enqueueJob.mock.calls)).not.toContain(
      "host-clone-secret"
    );
  });

  it("does not publish a GitHub deploy job when its transactional audit callback fails", async () => {
    vi.stubGlobal("fetch", mockSuccessfulGithubFetch());
    const repository = repoRow({
      host_clone_url: "git@github-private-app:owner/private-app.git",
      host_clone_directory: "/srv/apps/private-app",
      github_token_encrypted: encryptSecret("github_pat_secret")
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM github_repositories")) {
        return { rows: [repository] };
      }
      return { rows: [] };
    });
    enqueueJob.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000778",
      type: "git.cloneDeploy",
      hostId: "00000000-0000-4000-8000-000000000001",
      status: "queued"
    });
    const auditFailure = new Error("audit insert failed");
    const { deployGithubRepository } = await import("../src/services/github.js");

    await expect(deployGithubRepository(
      repository.id,
      {
        mode: "host_clone",
        hostId: "00000000-0000-4000-8000-000000000001",
        branch: "main",
        projectName: "private-app",
        hostCloneUrl: "git@github-private-app:owner/private-app.git",
        hostCloneDirectory: "/srv/apps/private-app"
      },
      "user-1",
      async () => {
        throw auditFailure;
      }
    )).rejects.toBe(auditFailure);

    expect(enqueueJob).toHaveBeenCalledOnce();
    expect(notifyJobQueued).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => (
      String(sql).includes("UPDATE github_repositories SET last_error")
    ))).toBe(false);
  });

  it("binds API-mode success to the queued job without stamping deployment success at enqueue", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const repository = repoRow({
      default_host_id: "00000000-0000-4000-8000-000000000001",
      github_token_encrypted: encryptSecret("github_pat_secret")
    });
    const stack = {
      id: "00000000-0000-4000-8000-000000000999",
      host_id: "00000000-0000-4000-8000-000000000001",
      name: "Private App",
      project_name: "private-app",
      compose_yaml: "services: {}\n",
      env: "",
      status: "created",
      source_type: "github",
      source_repository_url: "https://github.com/owner/private-app",
      source_branch: "main",
      source_compose_path: "docker-compose.yml",
      source_current_commit_sha: null,
      source_latest_commit_sha: githubCommitSha,
      created_at: new Date(0),
      updated_at: new Date(0)
    };
    query
      .mockResolvedValueOnce({ rows: [repository] })
      .mockResolvedValueOnce({ rows: [repository] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stack] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueJob.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000777",
      type: "compose.deploy",
      hostId: stack.host_id,
      payload: { stackId: stack.id },
      status: "queued"
    });
    const { deployGithubRepository } = await import("../src/services/github.js");

    await expect(deployGithubRepository(repository.id, {
      mode: "api",
      hostId: stack.host_id,
      branch: "main",
      projectName: "private-app"
    })).resolves.toMatchObject({
      stack: { id: stack.id, sourceCurrentCommitSha: null },
      job: { id: "00000000-0000-4000-8000-000000000777", status: "queued" },
      sourceCommitSha: githubCommitSha,
      composeSha256: githubComposeSha256,
      customCompose: false
    });

    const contentRequest = fetchMock.mock.calls.find(([input]) =>
      new URL(String(input)).pathname.endsWith("/contents/docker-compose.yml")
    );
    expect(new URL(String(contentRequest?.[0])).searchParams.get("ref")).toBe(
      githubCommitSha
    );
    const statements = query.mock.calls.map(([sql]) => String(sql));
    const stackUpsert = statements.find((sql) => sql.includes("INSERT INTO compose_stacks"));
    expect(stackUpsert).toContain("source_current_commit_sha");
    expect(stackUpsert).toContain("$9, null, $10");
    expect(stackUpsert).not.toContain("source_current_commit_sha = EXCLUDED");
    const bindingCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO github_deployment_jobs")
    );
    expect(bindingCall?.[1]).toEqual([
      "00000000-0000-4000-8000-000000000777",
      repository.id,
      stack.id,
      repository.repository_url,
      "main",
      "docker-compose.yml",
      githubCommitSha,
      githubComposeSha256,
      false
    ]);
    expect(statements.some((sql) => sql.includes("last_deployed_at"))).toBe(false);
    expect(statements.some((sql) => sql.includes("last_deployed_commit_sha"))).toBe(false);
  });

  it("marks caller-provided Compose as custom and binds its exact bytes", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const repository = repoRow({
      default_host_id: "00000000-0000-4000-8000-000000000001",
      github_token_encrypted: encryptSecret("github_pat_secret")
    });
    const customComposeYaml = "services:\n  custom:\n    image: nginx:alpine\n";
    const customComposeSha256 = createHash("sha256")
      .update(customComposeYaml, "utf8")
      .digest("hex");
    const stack = {
      id: "00000000-0000-4000-8000-000000000998",
      host_id: repository.default_host_id,
      name: "Private App",
      project_name: "private-app-custom",
      compose_yaml: customComposeYaml,
      env: "",
      status: "created",
      source_type: "github",
      source_repository_url: repository.repository_url,
      source_branch: "main",
      source_compose_path: "docker-compose.yml",
      source_current_commit_sha: null,
      source_latest_commit_sha: githubCommitSha,
      created_at: new Date(0),
      updated_at: new Date(0)
    };
    query
      .mockResolvedValueOnce({ rows: [repository] })
      .mockResolvedValueOnce({ rows: [repository] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stack] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    enqueueJob.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000776",
      type: "compose.deploy",
      hostId: stack.host_id,
      payload: { stackId: stack.id },
      status: "queued"
    });
    const { deployGithubRepository } = await import("../src/services/github.js");

    await expect(deployGithubRepository(repository.id, {
      mode: "api",
      hostId: stack.host_id,
      branch: "main",
      projectName: stack.project_name,
      composeYaml: customComposeYaml
    })).resolves.toMatchObject({
      sourceCommitSha: githubCommitSha,
      composeSha256: customComposeSha256,
      customCompose: true
    });

    expect(fetchMock.mock.calls.some(([input]) =>
      new URL(String(input)).pathname.includes("/contents/")
    )).toBe(false);
    const stackUpsert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    );
    expect(stackUpsert?.[1]).toContain(customComposeYaml);
    const bindingCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO github_deployment_jobs")
    );
    expect(bindingCall?.[1]).toEqual([
      "00000000-0000-4000-8000-000000000776",
      repository.id,
      stack.id,
      repository.repository_url,
      "main",
      "docker-compose.yml",
      githubCommitSha,
      customComposeSha256,
      true
    ]);
  });

  it("rejects API-mode Compose indirection before creating a stack or job", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const repository = repoRow({
      default_host_id: "00000000-0000-4000-8000-000000000001",
      github_token_encrypted: encryptSecret("github_pat_secret")
    });
    query.mockResolvedValueOnce({ rows: [repository] });
    const { deployGithubRepository } = await import("../src/services/github.js");

    await expect(deployGithubRepository(repository.id, {
      mode: "api",
      hostId: repository.default_host_id,
      branch: "main",
      projectName: "private-app",
      composeYaml: [
        "include:",
        "  - /tmp/unreviewed.yaml",
        "services:",
        "  app:",
        "    image: nginx:alpine"
      ].join("\n")
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("include is not supported")
    });

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
  });

  it("reuses stored tokens for GitHub version discovery by URL", async () => {
    const fetchMock = mockSuccessfulGithubFetch();
    vi.stubGlobal("fetch", fetchMock);
    query.mockResolvedValue({ rows: [repoRow({ github_token_encrypted: encryptSecret("github_pat_secret") })] });
    const { listGithubVersionsForUrlWithStoredCredentials } = await import("../src/services/github.js");

    const versions = await listGithubVersionsForUrlWithStoredCredentials("https://github.com/owner/private-app", {
      selectedRef: "main",
      currentCommitSha: githubCommitSha
    });

    expect(versions.options.map((option) => `${option.kind}:${option.ref}`)).toEqual([
      "branch:main",
      "tag:v1.0.0",
      "release:v1.0.0"
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
