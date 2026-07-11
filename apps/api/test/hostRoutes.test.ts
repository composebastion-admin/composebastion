import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

const createHostWithSync = vi.hoisted(() => vi.fn());
const enqueueJob = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  requireRole: () => async (request: any) => {
    request.user = { id: userId, role: "owner" };
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
  await registerHostRoutes(app);
  return app;
}

describe("host routes", () => {
  beforeEach(() => {
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
});
