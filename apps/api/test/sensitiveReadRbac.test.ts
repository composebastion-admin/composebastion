import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const currentRole = vi.hoisted(() => ({ value: "viewer" }));
const userId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const stackId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const secret = "qualification-secret-value";
const urlSecret = "git-url-only-secret";
const structuredUrlLikeName = "https:structured-user@display.example/app";
const structuredUrlLikePath = String.raw`/srv/https:\structured-user@path.example/source`;
const structuredUrlLikeRef = "https:/structured-user@ref.example/release";
const structuredUrlLikeCompose = `services:\n  app:\n    labels:\n      fixture: ${structuredUrlLikeName}\n`;
const unsafeDynamicKey = `https://key-user:${urlSecret}@keys.example.test/path`;
const safeDynamicKey = "https://keys.example.test/path";
const unsafeLatestHtmlUrl = `https://release-user:${urlSecret}@release.example.test/v1?token=${urlSecret}`;
const safeLatestHtmlUrl = "https://release.example.test/v1";
const query = vi.hoisted(() => vi.fn());
const cancelQueuedJob = vi.hoisted(() => vi.fn());
const enqueueJob = vi.hoisted(() => vi.fn());
const retryJob = vi.hoisted(() => vi.fn());
const updateApp = vi.hoisted(() => vi.fn());
const upsertAppSourceLink = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn(async () => undefined));

const sensitiveJob = {
  id: jobId,
  correlationId: jobId,
  type: structuredUrlLikeName,
  status: "failed",
  hostId,
  payload: {
    composeYaml: `services:\n  app:\n    environment:\n      TOKEN: ${secret}\n`,
    env: `TOKEN=${secret}\n`,
    repositoryUrl: `https://git-user:${urlSecret}@git.example.test/team/app.git?token=${urlSecret}`,
    hostCloneUrl: `ssh://git:${urlSecret}@git.example.test/team/app.git#${urlSecret}`,
    sourceInput: `https://git.example.test/team/app.git?token=${urlSecret}`
  },
  result: {
    stdout: `stdout ${secret}; remote https://git-user:${urlSecret}@git.example.test/team/app.git?token=${urlSecret}`,
    stderr: `stderr ${secret}; remote ssh://git:${urlSecret}@git.example.test/team/app.git#${urlSecret}`,
    diagnostics: {
      attempts: [
        `attempt ${secret}; remote https://git.example.test/team/app.git?token=${urlSecret}`,
        {
          message: `nested ${secret}; remote git://git-user:${urlSecret}@git.example.test/team/app.git`
        }
      ],
      [unsafeDynamicKey]: `first dynamic ${secret}`,
      [safeDynamicKey]: `second dynamic ${secret}`
    },
    repositoryUrl: `https://git-user:${urlSecret}@git.example.test/team/app.git#${urlSecret}`,
    sourceLocator: `https://git-user:${urlSecret}@git.example.test/team/app.git?token=${urlSecret}`
  },
  progress: [{
    id: "deploy",
    label: "Deploy",
    status: "failed",
    detail: `deployment failed: ${secret}; remote https://git-user:${urlSecret}@git.example.test/team/app.git?token=${urlSecret}`
  }],
  error: `deployment failed: ${secret}; remote https://git-user:${urlSecret}@git.example.test/team/app.git?token=${urlSecret}`,
  createdBy: userId,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString()
};

const sensitiveApp = {
  id: "app:sensitive",
  hostId,
  hostName: structuredUrlLikeName,
  hostHostname: "host.example.test",
  name: structuredUrlLikeName,
  source: "git",
  status: "running",
  imageReferences: [structuredUrlLikeName],
  ports: "",
  containerIds: [],
  primaryContainerId: null,
  stackId,
  repositoryId: null,
  repositoryUrl: `https://git-user:${urlSecret}@github.com/example/private.git?token=${urlSecret}`,
  branch: structuredUrlLikeRef,
  projectName: structuredUrlLikeName,
  sourceLink: {
    id: "66666666-6666-4666-8666-666666666666",
    sourceType: "git",
    name: structuredUrlLikeName,
    repositoryUrl: `https://git-user:${urlSecret}@github.com/example/private.git?token=${urlSecret}`,
    branch: structuredUrlLikeRef,
    workingDir: `${structuredUrlLikePath}/${secret}`,
    composePath: `${structuredUrlLikeRef}/${secret}.yaml`,
    imageReference: structuredUrlLikeName,
    currentCommitSha: null,
    latestCommitSha: null,
    checkedAt: null,
    checkError: `git failed: ${secret}; remote https://git-user:${urlSecret}@github.com/example/private.git?token=${urlSecret}`,
    updatedAt: new Date(0).toISOString()
  },
  update: {
    status: "error",
    kind: "git",
    checkedAt: null,
    riskNote: `update failed: ${secret}; remote ssh://git:${urlSecret}@github.com/example/private.git#${urlSecret}`
  },
  updatedAt: new Date(0).toISOString()
};

const stackRow = {
  id: stackId,
  host_id: hostId,
  name: "Sensitive stack",
  project_name: "sensitive",
  compose_yaml: `services:\n  app:\n    environment:\n      TOKEN: ${secret}\n`,
  env: `TOKEN=${secret}\n`,
  status: "deployed",
  current_version_id: null,
  current_version_number: null,
  domains: [],
  source_type: "git",
  source_repository_url: `https://example.invalid/repository.git?token=${secret}`,
  source_working_dir: `/srv/${secret}`,
  source_compose_path: `${secret}.yaml`,
  source_check_error: `source failed: ${secret}`,
  last_deploy_error: `deploy failed: ${secret}`,
  created_at: new Date(0),
  updated_at: new Date(0)
};

vi.mock("../src/services/auth.js", () => ({
  requireRole: (roles: string[]) => async (request: any, reply: any) => {
    if (!roles.includes(currentRole.value)) {
      reply.code(403).send({ error: "Insufficient permissions", code: "FORBIDDEN" });
      return;
    }
    request.user = { id: userId, role: currentRole.value };
  }
}));

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: async (
    handler: (client: { query: typeof query }) => Promise<unknown>
  ) => handler({ query })
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  writeAuditEvent
}));

vi.mock("../src/services/jobs.js", () => ({
  cancelQueuedJob,
  enqueueJob,
  getJob: vi.fn(async () => sensitiveJob),
  getWorkerStatus: vi.fn(async () => ({ queued: 0, running: 0, lastJobCompletedAt: null })),
  listJobs: vi.fn(async () => ({
    items: [sensitiveJob],
    total: 1,
    limit: 20,
    offset: 0,
    hasMore: false
  })),
  retryJob
}));

vi.mock("../src/services/stackVersions.js", () => ({
  diffStackVersions: vi.fn(async () => ({
    fromVersionId: "from",
    toVersionId: "to",
    fromVersionNumber: 1,
    toVersionNumber: 2,
    composeChanges: [{ type: "added", line: 1, text: secret }],
    envChanged: true
  })),
  listStackVersions: vi.fn(async () => [{
    id: "55555555-5555-4555-8555-555555555555",
    stackId,
    versionNumber: 1,
    composeYaml: secret,
    env: secret,
    source: "ui",
    note: null,
    createdBy: userId,
    createdAt: new Date(0).toISOString()
  }]),
  recordStackVersion: vi.fn(async () => undefined),
  rollbackStackVersion: vi.fn(async () => ({ version: {}, job: sensitiveJob }))
}));

vi.mock("../src/services/github.js", () => ({
  createGithubRepository: vi.fn(),
  deleteGithubRepository: vi.fn(),
  deployGithubRepository: vi.fn(),
  listGithubBranchesForRepository: vi.fn(),
  listGithubBranchesForUrl: vi.fn(),
  listGithubRepositories: vi.fn(async () => [{ id: "repository", env: `TOKEN=${secret}` }]),
  previewGithubRepositoryCompose: vi.fn(),
  testGithubRepositoryAccess: vi.fn(),
  testGithubRepositoryStoredAccess: vi.fn(),
  updateGithubRepository: vi.fn()
}));

vi.mock("../src/services/deployments.js", () => ({
  checkRegistryTrust: vi.fn(),
  createDeploymentAnalysis: vi.fn(),
  createDeploymentSource: vi.fn(),
  deleteDeploymentSource: vi.fn(),
  getDeploymentAnalysis: vi.fn(async () => ({
    id: "analysis",
    sourceInput: `https://example.invalid/compose.yml?token=${secret}`,
    composeYaml: secret,
    env: secret
  })),
  getDeploymentSource: vi.fn(async () => ({ id: "source", safeEnvironment: { CONFIG: secret } })),
  listDeploymentSources: vi.fn(async () => [{ id: "source", safeEnvironment: { CONFIG: secret } }]),
  normalizeRegistryTrustAuthority: (value: string) => {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw Object.assign(new Error("Registry trust accepts only a hostname and optional port."), { statusCode: 400 });
    }
    return parsed.host.toLowerCase();
  },
  queueDeployment: vi.fn(),
  updateDeploymentSource: vi.fn()
}));

vi.mock("../src/services/apps.js", () => ({
  checkAppUpdates: vi.fn(async () => [sensitiveApp]),
  deleteAppSourceLink: vi.fn(),
  listAppGithubVersions: vi.fn(async () => ({
    repositoryUrl: `https://git-user:${urlSecret}@github.com/example/private.git?token=${urlSecret}`,
    selectedRef: structuredUrlLikeRef,
    currentCommitSha: "a".repeat(40),
    options: [{
      kind: "branch",
      name: structuredUrlLikeName,
      ref: structuredUrlLikeRef,
      label: structuredUrlLikeName,
      commitSha: null,
      publishedAt: null,
      htmlUrl: structuredUrlLikePath,
      selected: true,
      deployed: true,
      updateAvailable: false
    }]
  })),
  listApps: vi.fn(async () => [sensitiveApp]),
  renameApp: vi.fn(async () => ({ app: sensitiveApp })),
  selectAppGithubVersion: vi.fn(async () => ({ app: sensitiveApp })),
  updateApp,
  upsertAppSourceLink
}));

vi.mock("../src/services/selfUpdate.js", () => ({
  checkSelfUpdateLatest: vi.fn(async () => ({
    version: "1.2.0",
    checkedAt: new Date(0).toISOString(),
    error: `release check ${secret}; remote https://git-user:${urlSecret}@github.com/example/private/releases?token=${urlSecret}`,
    htmlUrl: unsafeLatestHtmlUrl
  })),
  enqueueSelfUpdate: vi.fn(async () => sensitiveJob),
  getSelfUpdateStatus: vi.fn(async () => ({
    configured: true,
    config: {
      workingDir: structuredUrlLikePath,
      composeFile: structuredUrlLikeName
    },
    runtime: { version: "1.2.0-beta.1", revision: structuredUrlLikeRef },
    latest: {
      version: "1.2.0",
      checkedAt: new Date(0).toISOString(),
      error: null,
      htmlUrl: unsafeLatestHtmlUrl
    },
    updateAvailable: true,
    lastJob: sensitiveJob
  })),
  saveSelfUpdateConfig: vi.fn()
}));

const { registerAppRoutes } = await import("../src/routes/apps.js");
const { registerComposeRoutes } = await import("../src/routes/compose.js");
const { registerDeploymentRoutes } = await import("../src/routes/deployments.js");
const { registerGithubRoutes } = await import("../src/routes/github.js");
const { registerJobRoutes } = await import("../src/routes/jobs.js");
const { registerSelfUpdateRoutes } = await import("../src/routes/selfUpdate.js");

type Role = "viewer" | "operator" | "admin" | "owner";

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "Validation failed", code: "VALIDATION_FAILED", issues: error.issues });
      return;
    }
    const statusCode = Number((error as { statusCode?: number; status?: number }).statusCode
      ?? (error as { status?: number }).status
      ?? 500);
    reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Internal server error",
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_FAILED"
    });
  });
  await registerAppRoutes(app);
  await registerComposeRoutes(app);
  await registerDeploymentRoutes(app);
  await registerGithubRoutes(app);
  await registerJobRoutes(app);
  await registerSelfUpdateRoutes(app);
  return app;
}

async function injectAs(
  app: Awaited<ReturnType<typeof buildApp>>,
  role: Role,
  options: Parameters<typeof app.inject>[0]
) {
  currentRole.value = role;
  return app.inject(options);
}

describe("secret-bearing read boundaries", () => {
  beforeEach(() => {
    currentRole.value = "viewer";
    query.mockReset();
    query.mockResolvedValue({ rows: [stackRow] });
    enqueueJob.mockReset();
    enqueueJob.mockResolvedValue(sensitiveJob);
    cancelQueuedJob.mockReset();
    cancelQueuedJob.mockResolvedValue({ job: sensitiveJob, canceled: true });
    retryJob.mockReset();
    retryJob.mockResolvedValue({ original: sensitiveJob, retried: sensitiveJob });
    updateApp.mockReset();
    updateApp.mockResolvedValue({
      jobs: [sensitiveJob],
      mode: structuredUrlLikeName,
      branch: structuredUrlLikeRef,
      stack: {
        name: structuredUrlLikeName,
        workingDir: structuredUrlLikePath,
        composeYaml: structuredUrlLikeCompose
      }
    });
    upsertAppSourceLink.mockReset();
    upsertAppSourceLink.mockImplementation(async (_appId, input) => ({
      id: "77777777-7777-4777-8777-777777777777",
      ...input,
      currentCommitSha: null,
      latestCommitSha: null,
      checkedAt: null,
      checkError: null,
      updatedAt: new Date(0).toISOString()
    }));
    writeAuditEvent.mockClear();
  });

  it("keeps viewer Compose metadata readable while redacting definitions and raw errors", async () => {
    const app = await buildApp();
    try {
      const viewer = await injectAs(app, "viewer", {
        method: "GET",
        url: `/api/hosts/${hostId}/compose`
      });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).not.toContain(secret);
      expect(viewer.json().stacks[0]).toMatchObject({
        id: stackId,
        composeYaml: "",
        env: "",
        sourceRepositoryUrl: null,
        sourceWorkingDir: null,
        sourceComposePath: null,
        sensitiveFieldsRedacted: true
      });

      const operator = await injectAs(app, "operator", {
        method: "GET",
        url: `/api/hosts/${hostId}/compose`
      });
      expect(operator.statusCode).toBe(200);
      expect(operator.body).toContain(secret);
      expect(operator.body).not.toContain(urlSecret);
      expect(operator.json().stacks[0].sensitiveFieldsRedacted).toBeUndefined();
      expect(operator.json().stacks[0].sourceRepositoryUrl)
        .toBe("https://example.invalid/repository.git");
    } finally {
      await app.close();
    }
  });

  it("keeps the exact viewer job shape and recursively sanitizes every authorized job response", async () => {
    const app = await buildApp();
    try {
      for (const url of ["/api/jobs", `/api/jobs/${jobId}`]) {
        const viewer = await injectAs(app, "viewer", { method: "GET", url });
        expect(viewer.statusCode, url).toBe(200);
        expect(viewer.body, url).not.toContain(secret);
        expect(viewer.body, url).not.toContain(urlSecret);
        const job = url === "/api/jobs" ? viewer.json().jobs[0] : viewer.json().job;
        expect(job).toMatchObject({
          payload: {},
          result: null,
          sensitiveFieldsRedacted: true
        });
        expect(job.progress[0]).toEqual({ id: "deploy", label: "Deploy", status: "failed" });
        expect(job.error).toBe("Operation failed; details require operator access.");
      }

      const assertAuthorizedJob = (job: any) => {
        expect(JSON.stringify(job)).toContain(secret);
        expect(JSON.stringify(job)).not.toContain(urlSecret);
        expect(job.sensitiveFieldsRedacted).toBeUndefined();
        expect(job.type).toBe(structuredUrlLikeName);
        expect(job.payload).toMatchObject({
          repositoryUrl: "https://git.example.test/team/app.git",
          hostCloneUrl: "ssh://git@git.example.test/team/app.git",
          sourceInput: "https://git.example.test/team/app.git"
        });
        expect(job.result).toMatchObject({
          stdout: `stdout ${secret}; remote https://git.example.test/team/app.git`,
          stderr: `stderr ${secret}; remote ssh://git@git.example.test/team/app.git`,
          repositoryUrl: "https://git.example.test/team/app.git",
          sourceLocator: "https://git.example.test/team/app.git",
          diagnostics: {
            attempts: [
              `attempt ${secret}; remote https://git.example.test/team/app.git`,
              {
                message: `nested ${secret}; remote git://git.example.test/team/app.git`
              }
            ]
          }
        });
        expect(job.progress[0].detail)
          .toContain("remote https://git.example.test/team/app.git");
        expect(job.error)
          .toContain("remote https://git.example.test/team/app.git");
        expect(job.result.diagnostics[safeDynamicKey]).toBe(`first dynamic ${secret}`);
        expect(job.result.diagnostics[`${safeDynamicKey} [2]`])
          .toBe(`second dynamic ${secret}`);
      };

      for (const role of ["operator", "admin", "owner"] as Role[]) {
        const list = await injectAs(app, role, { method: "GET", url: "/api/jobs" });
        expect(list.statusCode, `${role} list`).toBe(200);
        assertAuthorizedJob(list.json().jobs[0]);
        assertAuthorizedJob(list.json().items[0]);

        const detail = await injectAs(app, role, { method: "GET", url: `/api/jobs/${jobId}` });
        expect(detail.statusCode, `${role} detail`).toBe(200);
        assertAuthorizedJob(detail.json().job);

        const canceled = await injectAs(app, role, {
          method: "POST",
          url: `/api/jobs/${jobId}/cancel`
        });
        expect(canceled.statusCode, `${role} cancel`).toBe(200);
        assertAuthorizedJob(canceled.json().job);

        const retried = await injectAs(app, role, {
          method: "POST",
          url: `/api/jobs/${jobId}/retry`
        });
        expect(retried.statusCode, `${role} retry`).toBe(200);
        assertAuthorizedJob(retried.json().job);
        assertAuthorizedJob(retried.json().original);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects unsafe GitHub branch and host-clone requests before service calls or audit", async () => {
    const github = await import("../src/services/github.js");
    const deploy = vi.mocked(github.deployGithubRepository);
    const branches = vi.mocked(github.listGithubBranchesForUrl);
    deploy.mockClear();
    branches.mockClear();
    writeAuditEvent.mockClear();
    const app = await buildApp();
    try {
      const branchResponse = await injectAs(app, "operator", {
        method: "POST",
        url: "/api/github/branches",
        payload: {
          repositoryUrl: `https://github.com/example/private?token=${secret}`
        }
      });
      expect(branchResponse.statusCode).toBe(400);

      const deployResponse = await injectAs(app, "operator", {
        method: "POST",
        url: "/api/github/repos/repository/deploy",
        payload: {
          mode: "host_clone",
          hostCloneUrl: `ssh://git:${secret}@github.com/example/private.git`
        }
      });
      expect(deployResponse.statusCode).toBe(400);
      expect(deploy).not.toHaveBeenCalled();
      expect(branches).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("distinguishes ambiguous non-idempotent worker loss from generic retry ineligibility", async () => {
    const app = await buildApp();
    try {
      retryJob.mockResolvedValueOnce({
        original: {
          ...sensitiveJob,
          type: "deploy.execute",
          error: `WORKER_LOST: remote https://git-user:${secret}@git.example.test/team/app.git`
        },
        retried: null
      });
      const ambiguous = await injectAs(app, "operator", {
        method: "POST",
        url: `/api/jobs/${jobId}/retry`
      });
      expect(ambiguous.statusCode).toBe(409);
      expect(ambiguous.json().error).toContain("Reconcile the deployment or registry state");
      expect(ambiguous.body).not.toContain(secret);

      retryJob.mockResolvedValueOnce({
        original: { ...sensitiveJob, type: "deploy.analyze", status: "running" },
        retried: null
      });
      const generic = await injectAs(app, "operator", {
        method: "POST",
        url: `/api/jobs/${jobId}/retry`
      });
      expect(generic.statusCode).toBe(409);
      expect(generic.json().error).toContain("status, operation type, host assignment, or attempt limit");
    } finally {
      await app.close();
    }
  });

  it("sanitizes legacy self-update jobs in status, check, and start responses", async () => {
    const app = await buildApp();
    try {
      for (const role of ["viewer", "operator"] as Role[]) {
        expect((await injectAs(app, role, {
          method: "GET",
          url: "/api/self-update"
        })).statusCode).toBe(403);
      }

      for (const role of ["admin", "owner"] as Role[]) {
        const status = await injectAs(app, role, {
          method: "GET",
          url: "/api/self-update"
        });
        expect(status.statusCode, `${role} status`).toBe(200);
        expect(status.body).toContain(secret);
        expect(status.body).not.toContain(urlSecret);
        expect(status.json().config).toEqual({
          workingDir: structuredUrlLikePath,
          composeFile: structuredUrlLikeName
        });
        expect(status.json().runtime).toEqual({
          version: "1.2.0-beta.1",
          revision: structuredUrlLikeRef
        });
        expect(status.json().latest.htmlUrl).toBe(safeLatestHtmlUrl);
        expect(status.json().lastJob.type).toBe(structuredUrlLikeName);
        expect(status.json().lastJob.result).toMatchObject({
          stdout: `stdout ${secret}; remote https://git.example.test/team/app.git`,
          stderr: `stderr ${secret}; remote ssh://git@git.example.test/team/app.git`
        });

        const checked = await injectAs(app, role, {
          method: "POST",
          url: "/api/self-update/check",
          payload: {}
        });
        expect(checked.statusCode, `${role} check`).toBe(200);
        expect(checked.body).toContain(secret);
        expect(checked.body).not.toContain(urlSecret);
        expect(checked.json().config).toEqual({
          workingDir: structuredUrlLikePath,
          composeFile: structuredUrlLikeName
        });
        expect(checked.json().runtime.revision).toBe(structuredUrlLikeRef);
        expect(checked.json().latest.htmlUrl).toBe(safeLatestHtmlUrl);
        expect(checked.json().latest.error)
          .toBe(`release check ${secret}; remote https://github.com/example/private/releases`);
        expect(checked.json().lastJob.result.diagnostics.attempts[1].message)
          .toBe(`nested ${secret}; remote git://git.example.test/team/app.git`);

        const started = await injectAs(app, role, {
          method: "POST",
          url: "/api/self-update/start",
          payload: { targetVersion: "1.2.0" }
        });
        expect(started.statusCode, `${role} start`).toBe(200);
        expect(started.body).toContain(secret);
        expect(started.body).not.toContain(urlSecret);
        expect(started.json().job.type).toBe(structuredUrlLikeName);
        expect(started.json().job.result.stdout)
          .toBe(`stdout ${secret}; remote https://git.example.test/team/app.git`);
      }
    } finally {
      await app.close();
    }
  });

  it("operator-gates definition-bearing history, My Library, GitHub, and analysis reads", async () => {
    const app = await buildApp();
    try {
      const routes = [
        `/api/compose/${stackId}/versions`,
        `/api/compose/${stackId}/versions/diff?from=from&to=to`,
        "/api/github/repos",
        "/api/deploy/analyses/analysis",
        "/api/deployment-sources",
        "/api/deployment-sources/source"
      ];
      for (const url of routes) {
        expect((await injectAs(app, "viewer", { method: "GET", url })).statusCode, url).toBe(403);
        expect((await injectAs(app, "operator", { method: "GET", url })).statusCode, url).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("preserves the viewer app shape and sanitizes every authorized app outward response", async () => {
    const app = await buildApp();
    upsertAppSourceLink.mockResolvedValue(sensitiveApp.sourceLink);
    try {
      const viewer = await injectAs(app, "viewer", { method: "GET", url: "/api/apps" });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).not.toContain(secret);
      expect(viewer.body).not.toContain(urlSecret);
      expect(viewer.body).not.toContain("git-user");
      expect((await injectAs(app, "viewer", {
        method: "GET",
        url: "/api/apps/app%3Asensitive/versions"
      })).statusCode).toBe(403);

      const viewerApps = viewer.json().apps;
      expect(viewerApps[0]).toMatchObject({
        hostName: structuredUrlLikeName,
        name: structuredUrlLikeName,
        imageReferences: [structuredUrlLikeName],
        branch: structuredUrlLikeRef,
        projectName: structuredUrlLikeName,
        repositoryUrl: "https://github.com/example/private.git",
        sensitiveFieldsRedacted: true,
        sourceLink: {
          name: structuredUrlLikeName,
          repositoryUrl: "https://github.com/example/private.git",
          branch: structuredUrlLikeRef,
          imageReference: structuredUrlLikeName,
          workingDir: null,
          composePath: null,
          checkError: "Source check failed; details require operator access."
        },
        update: { riskNote: "Update details require operator access." }
      });

      const assertAuthorizedApp = (outwardApp: any) => {
        expect(JSON.stringify(outwardApp)).toContain(secret);
        expect(JSON.stringify(outwardApp)).not.toContain(urlSecret);
        expect(JSON.stringify(outwardApp)).not.toContain("git-user");
        expect(outwardApp.sensitiveFieldsRedacted).toBeUndefined();
        expect(outwardApp).toMatchObject({
          hostName: structuredUrlLikeName,
          name: structuredUrlLikeName,
          imageReferences: [structuredUrlLikeName],
          branch: structuredUrlLikeRef,
          projectName: structuredUrlLikeName
        });
        expect(outwardApp.repositoryUrl).toBe("https://github.com/example/private.git");
        expect(outwardApp.sourceLink).toMatchObject({
          name: structuredUrlLikeName,
          repositoryUrl: "https://github.com/example/private.git",
          branch: structuredUrlLikeRef,
          workingDir: `${structuredUrlLikePath}/${secret}`,
          composePath: `${structuredUrlLikeRef}/${secret}.yaml`,
          imageReference: structuredUrlLikeName,
          checkError: `git failed: ${secret}; remote https://github.com/example/private.git`
        });
        expect(outwardApp.update.riskNote)
          .toBe(`update failed: ${secret}; remote ssh://git@github.com/example/private.git`);
      };

      for (const role of ["operator", "admin", "owner"] as Role[]) {
        const list = await injectAs(app, role, { method: "GET", url: "/api/apps" });
        expect(list.statusCode, `${role} list`).toBe(200);
        assertAuthorizedApp(list.json().apps[0]);

        const checked = await injectAs(app, role, {
          method: "POST",
          url: "/api/apps/check-updates",
          payload: {}
        });
        expect(checked.statusCode, `${role} check`).toBe(200);
        assertAuthorizedApp(checked.json().apps[0]);

        const renamed = await injectAs(app, role, {
          method: "PUT",
          url: "/api/apps/app%3Asensitive/name",
          payload: { name: "Sensitive app" }
        });
        expect(renamed.statusCode, `${role} rename`).toBe(200);
        assertAuthorizedApp(renamed.json().app);

        const selected = await injectAs(app, role, {
          method: "PUT",
          url: "/api/apps/app%3Asensitive/version",
          payload: { ref: "main", kind: "branch" }
        });
        expect(selected.statusCode, `${role} select version`).toBe(200);
        assertAuthorizedApp(selected.json().app);

        const versions = await injectAs(app, role, {
          method: "GET",
          url: "/api/apps/app%3Asensitive/versions"
        });
        expect(versions.statusCode, `${role} versions`).toBe(200);
        expect(versions.body).not.toContain(urlSecret);
        expect(versions.body).not.toContain("git-user");
        expect(versions.json().versions.repositoryUrl)
          .toBe("https://github.com/example/private.git");
        expect(versions.json().versions.selectedRef).toBe(structuredUrlLikeRef);
        expect(versions.json().versions.options[0]).toMatchObject({
          name: structuredUrlLikeName,
          ref: structuredUrlLikeRef,
          label: structuredUrlLikeName,
          htmlUrl: structuredUrlLikePath
        });

        const update = await injectAs(app, role, {
          method: "POST",
          url: "/api/apps/app%3Asensitive/update"
        });
        expect(update.statusCode, `${role} update`).toBe(200);
        expect(update.body).toContain(secret);
        expect(update.body).not.toContain(urlSecret);
        expect(update.json().jobs[0].result.stdout)
          .toBe(`stdout ${secret}; remote https://git.example.test/team/app.git`);
        expect(update.json()).toMatchObject({
          mode: structuredUrlLikeName,
          branch: structuredUrlLikeRef,
          stack: {
            name: structuredUrlLikeName,
            workingDir: structuredUrlLikePath,
            composeYaml: structuredUrlLikeCompose
          }
        });

        const source = await injectAs(app, role, {
          method: "PUT",
          url: "/api/apps/app%3Asensitive/source",
          payload: {
            sourceType: "git",
            repositoryUrl: "https://github.com/example/private.git",
            branch: "main",
            workingDir: "/srv/private",
            composePath: "compose.yaml"
          }
        });
        expect(source.statusCode, `${role} source`).toBe(200);
        expect(source.body).toContain(secret);
        expect(source.body).not.toContain(urlSecret);
        expect(source.json().link).toMatchObject({
          name: structuredUrlLikeName,
          repositoryUrl: "https://github.com/example/private.git",
          branch: structuredUrlLikeRef,
          workingDir: `${structuredUrlLikePath}/${secret}`,
          composePath: `${structuredUrlLikeRef}/${secret}.yaml`,
          imageReference: structuredUrlLikeName,
          checkError: `git failed: ${secret}; remote https://github.com/example/private.git`
        });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects credential-bearing manual Git source links before persistence or audit", async () => {
    const app = await buildApp();
    const appId = encodeURIComponent("container:standalone");
    try {
      const rejected = await injectAs(app, "operator", {
        method: "PUT",
        url: `/api/apps/${appId}/source`,
        payload: {
          sourceType: "git",
          repositoryUrl: `https://git-user:${secret}@git.example.test/team/app.git?token=${secret}`,
          branch: "main",
          workingDir: "/srv/app",
          composePath: "compose.yaml"
        }
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.body).not.toContain(secret);
      expect(upsertAppSourceLink).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();

      const accepted = await injectAs(app, "operator", {
        method: "PUT",
        url: `/api/apps/${appId}/source`,
        payload: {
          sourceType: "git",
          repositoryUrl: "git@git-host-alias:team/app.git",
          branch: "main",
          workingDir: "/srv/app",
          composePath: "compose.yaml"
        }
      });
      expect(accepted.statusCode).toBe(200);
      expect(upsertAppSourceLink).toHaveBeenCalledWith("container:standalone", {
        sourceType: "git",
        repositoryUrl: "git@git-host-alias:team/app.git",
        branch: "main",
        workingDir: "/srv/app",
        composePath: "compose.yaml"
      });
      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: "app.source_link",
        details: { sourceType: "git" }
      }));
    } finally {
      await app.close();
    }
  });

  it("audits proxy configuration and forget-only deletion without retaining proxy values", async () => {
    const app = await buildApp();
    const sensitiveDomain = `${secret}.example.test`;
    try {
      const proxyResponse = await injectAs(app, "operator", {
        method: "PUT",
        url: `/api/compose/${stackId}/proxy`,
        payload: {
          domains: [sensitiveDomain],
          exposedService: "web",
          exposedPort: 443,
          tlsDesired: true
        }
      });
      expect(proxyResponse.statusCode, proxyResponse.body).toBe(200);
      const proxyEvent = writeAuditEvent.mock.calls.find(([input]) => input.action === "compose.proxy.update")?.[0];
      expect(proxyEvent).toMatchObject({
        userId,
        hostId,
        action: "compose.proxy.update",
        targetKind: "compose_stack",
        targetId: stackId,
        details: { proxyConfigurationUpdated: true }
      });
      expect(JSON.stringify(proxyEvent)).not.toContain(sensitiveDomain);
      expect(JSON.stringify(proxyEvent)).not.toContain(secret);

      const forgetResponse = await injectAs(app, "operator", {
        method: "DELETE",
        url: `/api/compose/${stackId}`
      });
      expect(forgetResponse.statusCode).toBe(200);
      const forgetEvent = writeAuditEvent.mock.calls.find(([input]) => input.action === "compose.forget")?.[0];
      expect(forgetEvent).toMatchObject({
        userId,
        hostId,
        action: "compose.forget",
        targetKind: "compose_stack",
        targetId: stackId,
        details: { dockerResourcesRemoved: false }
      });
      expect(JSON.stringify(forgetEvent)).not.toContain(secret);
    } finally {
      await app.close();
    }
  });

  it("rejects credential-bearing registry trust input before enqueue or audit", async () => {
    const app = await buildApp();
    try {
      const rejected = await injectAs(app, "owner", {
        method: "POST",
        url: `/api/hosts/${hostId}/registry-trust/apply`,
        payload: {
          registry: `http://registry-user:${secret}@registry.internal:5000`,
          insecure: true
        }
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.body).not.toContain(secret);
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();

      const accepted = await injectAs(app, "owner", {
        method: "POST",
        url: `/api/hosts/${hostId}/registry-trust/apply`,
        payload: {
          registry: "HTTP://Registry.Internal:5000/",
          insecure: true
        }
      });
      expect(accepted.statusCode).toBe(202);
      expect(enqueueJob).toHaveBeenCalledWith({
        type: "host.configureRegistryTrust",
        hostId,
        payload: { registry: "registry.internal:5000" }
      }, userId);
      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: "host.configure_registry_trust",
        details: { registry: "registry.internal:5000" }
      }));
      expect(JSON.stringify(enqueueJob.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
