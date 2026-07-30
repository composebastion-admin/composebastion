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
const query = vi.hoisted(() => vi.fn());
const enqueueJob = vi.hoisted(() => vi.fn());
const retryJob = vi.hoisted(() => vi.fn());
const upsertAppSourceLink = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn(async () => undefined));

const sensitiveJob = {
  id: jobId,
  correlationId: jobId,
  type: "compose.writeDeployPath",
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
    stdout: secret,
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
  cancelQueuedJob: vi.fn(async () => ({ job: sensitiveJob, canceled: false })),
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
  checkAppUpdates: vi.fn(),
  deleteAppSourceLink: vi.fn(),
  listAppGithubVersions: vi.fn(async () => ({
    repositoryUrl: `https://git-user:${secret}@github.com/example/private.git?token=${secret}`,
    selectedRef: "main",
    currentCommitSha: "a".repeat(40),
    options: []
  })),
  listApps: vi.fn(async () => [{
    id: "app:sensitive",
    hostId,
    hostName: "Sensitive host",
    hostHostname: "host.example.test",
    name: "Sensitive app",
    source: "git",
    status: "running",
    imageReferences: [],
    ports: "",
    containerIds: [],
    primaryContainerId: null,
    stackId,
    repositoryId: null,
    repositoryUrl: `https://git-user:${secret}@github.com/example/private.git?token=${secret}`,
    branch: "main",
    projectName: "sensitive",
    sourceLink: {
      id: "66666666-6666-4666-8666-666666666666",
      sourceType: "git",
      name: "Sensitive source",
      repositoryUrl: `https://git-user:${secret}@github.com/example/private.git?token=${secret}`,
      branch: "main",
      workingDir: `/srv/${secret}`,
      composePath: `${secret}.yaml`,
      imageReference: null,
      currentCommitSha: null,
      latestCommitSha: null,
      checkedAt: null,
      checkError: `git failed: ${secret}`,
      updatedAt: new Date(0).toISOString()
    },
    update: {
      status: "error",
      kind: "git",
      checkedAt: null,
      riskNote: `update failed: ${secret}`
    },
    updatedAt: new Date(0).toISOString()
  }]),
  renameApp: vi.fn(),
  selectAppGithubVersion: vi.fn(),
  updateApp: vi.fn(),
  upsertAppSourceLink
}));

const { registerAppRoutes } = await import("../src/routes/apps.js");
const { registerComposeRoutes } = await import("../src/routes/compose.js");
const { registerDeploymentRoutes } = await import("../src/routes/deployments.js");
const { registerGithubRoutes } = await import("../src/routes/github.js");
const { registerJobRoutes } = await import("../src/routes/jobs.js");

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
    retryJob.mockReset();
    retryJob.mockResolvedValue({ original: sensitiveJob, retried: null });
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

  it("returns viewer-safe job status without payload, result, progress detail, or raw error", async () => {
    const app = await buildApp();
    try {
      for (const url of ["/api/jobs", `/api/jobs/${jobId}`]) {
        const viewer = await injectAs(app, "viewer", { method: "GET", url });
        expect(viewer.statusCode, url).toBe(200);
        expect(viewer.body, url).not.toContain(secret);
        const job = url === "/api/jobs" ? viewer.json().jobs[0] : viewer.json().job;
        expect(job).toMatchObject({
          payload: {},
          result: null,
          sensitiveFieldsRedacted: true
        });
        expect(job.progress[0]).toEqual({ id: "deploy", label: "Deploy", status: "failed" });
        expect(job.error).toBe("Operation failed; details require operator access.");
      }

      const operator = await injectAs(app, "operator", { method: "GET", url: `/api/jobs/${jobId}` });
      expect(operator.statusCode).toBe(200);
      expect(operator.body).toContain(secret);
      expect(operator.body).not.toContain(urlSecret);
      expect(operator.json().job.sensitiveFieldsRedacted).toBeUndefined();
      expect(operator.json().job.payload.repositoryUrl)
        .toBe("https://git.example.test/team/app.git");
      expect(operator.json().job.result.repositoryUrl)
        .toBe("https://git.example.test/team/app.git");
      expect(operator.json().job.payload).toMatchObject({
        hostCloneUrl: "ssh://git@git.example.test/team/app.git",
        sourceInput: "https://git.example.test/team/app.git"
      });
      expect(operator.json().job.result.sourceLocator)
        .toBe("https://git.example.test/team/app.git");
      expect(operator.json().job.progress[0].detail)
        .toContain("remote https://git.example.test/team/app.git");
      expect(operator.json().job.error)
        .toContain("remote https://git.example.test/team/app.git");
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

  it("removes embedded credentials, host paths, and raw source errors from viewer app reads", async () => {
    const app = await buildApp();
    try {
      const viewer = await injectAs(app, "viewer", { method: "GET", url: "/api/apps" });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.body).not.toContain(secret);
      expect(viewer.body).not.toContain("git-user");
      expect((await injectAs(app, "viewer", {
        method: "GET",
        url: "/api/apps/app%3Asensitive/versions"
      })).statusCode).toBe(403);

      const viewerApps = viewer.json().apps;
      expect(viewerApps[0]).toMatchObject({
        repositoryUrl: "https://github.com/example/private.git",
        sensitiveFieldsRedacted: true,
        sourceLink: {
          repositoryUrl: "https://github.com/example/private.git",
          workingDir: null,
          composePath: null,
          checkError: "Source check failed; details require operator access."
        },
        update: { riskNote: "Update details require operator access." }
      });

      const operator = await injectAs(app, "operator", { method: "GET", url: "/api/apps" });
      expect(operator.statusCode).toBe(200);
      expect(operator.body).toContain(secret);
      expect(operator.body).not.toContain("git-user");
      expect(operator.json().apps[0].sensitiveFieldsRedacted).toBeUndefined();

      const operatorVersions = await injectAs(app, "operator", {
        method: "GET",
        url: "/api/apps/app%3Asensitive/versions"
      });
      expect(operatorVersions.statusCode).toBe(200);
      expect(operatorVersions.body).not.toContain(secret);
      expect(operatorVersions.body).not.toContain("git-user");
      expect(operatorVersions.json().versions.repositoryUrl)
        .toBe("https://github.com/example/private.git");
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
