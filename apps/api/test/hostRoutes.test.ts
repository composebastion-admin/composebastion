import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const userId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const analysisId = "44444444-4444-4444-8444-444444444444";

const currentRole = vi.hoisted(() => ({ value: "owner" }));
const createHostWithSync = vi.hoisted(() => vi.fn());
const enqueueJob = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  requireRole: (roles: string[]) => async (request: any, reply: any) => {
    if (!roles.includes(currentRole.value)) {
      reply.code(403).send({ error: "Insufficient permissions", code: "FORBIDDEN" });
      return;
    }
    request.user = { id: userId, role: currentRole.value };
  }
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  writeAuditEvent
}));

vi.mock("../src/services/docker.js", () => ({
  listImageCleanupCandidates: vi.fn(async () => []),
  listResources: vi.fn(async () => [])
}));

vi.mock("../src/services/hosts.js", () => ({
  createHostWithSync,
  deleteHost: vi.fn(async () => undefined),
  getHost: vi.fn(async () => null),
  listHosts: vi.fn(async () => []),
  restoreHost: vi.fn(async () => null),
  updateHost: vi.fn(async () => null)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob
}));

const { registerHostRoutes } = await import("../src/routes/hosts.js");

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "Validation failed", code: "VALIDATION_FAILED", issues: error.issues });
      return;
    }
    throw error;
  });
  await registerHostRoutes(app);
  return app;
}

describe("host routes", () => {
  beforeEach(() => {
    currentRole.value = "owner";
    createHostWithSync.mockReset();
    enqueueJob.mockReset();
    writeAuditEvent.mockReset();

    const host = {
      id: hostId,
      name: "Prod",
      hostname: "10.0.0.10",
      port: 22,
      username: "docker"
    };
    const job = {
      id: jobId,
      correlationId: jobId,
      type: "host.sync",
      status: "queued",
      hostId,
      payload: {},
      result: null,
      progress: [],
      error: null,
      createdBy: userId,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      startedAt: null,
      completedAt: null
    };
    createHostWithSync.mockResolvedValue({ host, job });
    enqueueJob.mockResolvedValue(job);
    writeAuditEvent.mockResolvedValue(undefined);
  });

  it("queues an initial inventory sync when a host is created", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "Prod",
          hostname: "10.0.0.10",
          port: 22,
          username: "docker",
          connectionMode: "ssh",
          sshAuthType: "password",
          sshPassword: "secret",
          dockerSocketPath: "/var/run/docker.sock"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(createHostWithSync).toHaveBeenCalledWith(expect.objectContaining({ name: "Prod" }), userId);
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(response.json().job).toMatchObject({ type: "host.sync", status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("rejects dedicated-only actions instead of letting the generic operator route bypass their controls", async () => {
    const app = await buildApp();
    currentRole.value = "operator";
    const actions = [
      { type: "deploy.analyze", payload: { analysisId } },
      { type: "deploy.execute", payload: { analysisId } },
      { type: "host.configureRegistryTrust", payload: { registry: "registry.internal:5000" } },
      {
        type: "git.cloneDeploy",
        payload: {
          repositoryUrl: "https://github.com/example/app.git",
          directory: "/srv/app",
          projectName: "app"
        }
      },
      {
        type: "container.clone",
        payload: { targetHostId: analysisId, containerId: "web", start: false }
      },
      { type: "volume.backup", payload: { backupId: analysisId, volumeName: "app_data" } },
      {
        type: "volume.restore",
        payload: { backupId: analysisId, targetVolumeName: "app_restored", overwrite: false }
      },
      {
        type: "volume.clone",
        payload: {
          targetHostId: analysisId,
          sourceVolumeName: "app_data",
          targetVolumeName: "app_copy",
          overwrite: false
        }
      },
      { type: "hostPath.backup", payload: { backupId: analysisId, sourcePath: "/srv/app" } },
      {
        type: "hostPath.restore",
        payload: { backupId: analysisId, targetPath: "/srv/restored", overwrite: false }
      },
      { type: "backup.verify", payload: { backupId: analysisId, testArchive: false } },
      { type: "backup.drill", payload: { backupId: analysisId } },
      { type: "recovery.create", payload: { recoveryPointId: analysisId, stopFirst: false } },
      { type: "recovery.capture", payload: { recoveryPointId: analysisId, stopFirst: false } },
      { type: "recovery.verify", payload: { recoveryPointId: analysisId } },
      { type: "recovery.restore", payload: { recoveryPointId: analysisId, mode: "clone" } },
      {
        type: "migration.execute",
        payload: { migrationRunId: analysisId, strategy: "clone" }
      },
      {
        type: "compose.writeDeployPath",
        payload: {
          projectName: "app",
          workingDir: "/srv/app",
          composePath: "compose.yaml",
          composeYaml: "services:\n  app:\n    image: nginx:alpine\n"
        }
      },
      { type: "compose.deploy", payload: { stackId: analysisId } },
      { type: "compose.stop", payload: { stackId: analysisId } },
      { type: "compose.remove", payload: { stackId: analysisId, removeVolumes: false } },
      { type: "registry.login", payload: { registryId: analysisId } },
      {
        type: "system.self_update",
        payload: {
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "latest",
          targetVersion: "latest"
        }
      }
    ];
    try {
      for (const payload of actions) {
        const response = await app.inject({
          method: "POST",
          url: `/api/hosts/${hostId}/actions`,
          payload
        });
        expect(response.statusCode, `${payload.type}: ${response.body}`).toBe(400);
        expect(response.json()).toMatchObject({
          code: "VALIDATION_FAILED",
          error: expect.stringContaining("dedicated API endpoint")
        });
      }
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns validation errors for missing, null, and non-object action bodies", async () => {
    const app = await buildApp();
    currentRole.value = "operator";
    const malformedBodies = [
      { label: "missing body", raw: undefined },
      { label: "null body", raw: "null" },
      { label: "array body", raw: "[]" },
      { label: "string body", raw: JSON.stringify("container.restart") },
      { label: "missing action type", raw: "{}" }
    ];
    try {
      for (const body of malformedBodies) {
        const response = await app.inject({
          method: "POST",
          url: `/api/hosts/${hostId}/actions`,
          ...(body.raw === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                payload: body.raw
              })
        });

        expect(response.statusCode, `${body.label}: ${response.body}`).toBe(400);
        expect(response.json(), body.label).toMatchObject({
          code: "VALIDATION_FAILED",
          error: expect.stringMatching(/JSON object|supported direct action type/)
        });
      }
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("continues to allow normal operator Docker actions", async () => {
    const app = await buildApp();
    currentRole.value = "operator";
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/actions`,
        payload: {
          type: "container.restart",
          payload: { containerId: "web" }
        }
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(enqueueJob).toHaveBeenCalledWith(
        { type: "container.restart", hostId, payload: { containerId: "web" } },
        userId,
        undefined
      );
      expect(writeAuditEvent).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("rejects credential-bearing direct Git actions before enqueue or audit", async () => {
    const app = await buildApp();
    currentRole.value = "operator";
    const secret = "direct-git-secret";
    const repositoryUrls = [
      `https://git-user:${secret}@git.example.test/team/app.git`,
      `https://git.example.test/team/app.git?token=${secret}`,
      `https://git.example.test/team/app.git#${secret}`
    ];
    try {
      for (const type of ["git.clone", "git.testRemote"] as const) {
        for (const repositoryUrl of repositoryUrls) {
          const response = await app.inject({
            method: "POST",
            url: `/api/hosts/${hostId}/actions`,
            payload: {
              type,
              payload: {
                repositoryUrl,
                ...(type === "git.clone" ? { directory: "/srv/app" } : {})
              }
            }
          });
          expect(response.statusCode, `${type}: ${repositoryUrl}: ${response.body}`).toBe(400);
          expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
          expect(response.body).not.toContain(secret);
        }
      }
      expect(enqueueJob).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();

      const safe = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/actions`,
        payload: {
          type: "git.testRemote",
          payload: { repositoryUrl: "git@git-host-alias:team/app.git" }
        }
      });
      expect(safe.statusCode).toBe(200);
      expect(enqueueJob).toHaveBeenCalledWith({
        type: "git.testRemote",
        hostId,
        payload: {
          repositoryUrl: "git@git-host-alias:team/app.git"
        }
      }, userId, undefined);
    } finally {
      await app.close();
    }
  });
});
