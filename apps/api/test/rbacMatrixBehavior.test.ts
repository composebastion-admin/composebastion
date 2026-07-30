import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentRole = vi.hoisted(() => ({ value: "viewer" }));
const userId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const targetHostId = "22222222-2222-4222-8222-222222222223";
const backupId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const channelId = "55555555-5555-4555-8555-555555555555";
const ruleId = "66666666-6666-4666-8666-666666666666";
const execInContainer = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn(async () => undefined));
const transactionQuery = vi.hoisted(() => vi.fn());

const okJob = {
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
  listAuditEvents: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0, hasMore: false })),
  writeAuditEvent
}));

vi.mock("../src/db/pool.js", () => ({
  query: transactionQuery,
  withTransaction: async (
    handler: (client: { query: typeof transactionQuery }) => Promise<unknown>
  ) => handler({ query: transactionQuery })
}));

vi.mock("../src/services/alerts.js", () => ({
  createAlertRule: vi.fn(async () => ({ id: "alert-rule" })),
  createAlertSilence: vi.fn(async () => ({ id: "alert-silence", hostId })),
  createChannel: vi.fn(async () => ({ id: "channel" })),
  deleteAlertRule: vi.fn(async () => undefined),
  deleteAlertSilence: vi.fn(async () => undefined),
  deleteChannel: vi.fn(async () => undefined),
  listAlertChannelTestEvents: vi.fn(async () => []),
  listAlertEvents: vi.fn(async () => []),
  listAlertRules: vi.fn(async () => []),
  listAlertSilences: vi.fn(async () => []),
  listChannels: vi.fn(async () => []),
  listRecentAlertChannelTestEvents: vi.fn(async () => []),
  sendTestNotification: vi.fn(async () => ({ id: "test-event" }))
}));

vi.mock("../src/services/docker.js", () => ({
  execInContainer,
  getContainerInspect: vi.fn(async () => ({ env: ["SECRET=value"], mounts: [], networks: [], ports: [], labels: {} })),
  getContainerLogs: vi.fn(async () => ({ logs: "ok" })),
  getContainerStats: vi.fn(async () => ({ id: "container" })),
  getContainerUsage: vi.fn(async () => []),
  getContainerVolumeMounts: vi.fn(async () => []),
  redactInspectEnv: vi.fn((inspect) => ({ ...inspect, env: ["SECRET=<redacted>"] })),
  streamContainerLogs: vi.fn(),
  streamContainerUsage: vi.fn()
}));

vi.mock("../src/services/backups.js", () => ({
  createBackupRecord: vi.fn(async () => ({ id: backupId, hostId, volumeName: "data", kind: "volume" })),
  createBackupWithJob: vi.fn(async () => ({ backup: { id: backupId, hostId, volumeName: "data", kind: "volume" }, job: okJob })),
  createHostPathBackupRecord: vi.fn(async () => ({ id: backupId, hostId, sourcePath: "/srv/app", kind: "host_path" })),
  createHostPathBackupWithJob: vi.fn(async () => ({ backup: { id: backupId, hostId, sourcePath: "/srv/app", kind: "host_path" }, job: okJob })),
  createVolumeBackupsWithJobs: vi.fn(async () => ({ backups: [], jobs: [] })),
  createVolumeCloneWithJob: vi.fn(async (
    _input: unknown,
    _createdBy: unknown,
    onCreated?: (client: { query: typeof transactionQuery }, result: unknown) => Promise<void>
  ) => {
    const result = { backup: { id: backupId, hostId, kind: "volume" }, job: okJob };
    await onCreated?.({ query: transactionQuery }, result);
    return result;
  }),
  deleteBackup: vi.fn(async () => ({ id: backupId, hostId, kind: "volume", volumeName: "data" })),
  getBackup: vi.fn(async () => ({ id: backupId, hostId, kind: "volume", volumeName: "data" })),
  getBackupDownloadStream: vi.fn(async () => null),
  getBackupHealthSummary: vi.fn(async () => ({ overall: { status: "healthy" }, hosts: [] })),
  listBackups: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0, hasMore: false }))
}));

vi.mock("../src/services/jobs.js", () => ({
  cancelQueuedJob: vi.fn(async () => ({ job: okJob, canceled: true })),
  enqueueJob: vi.fn(async () => okJob),
  enqueueJobInTransaction: vi.fn(async () => okJob),
  getJob: vi.fn(async () => okJob),
  getWorkerStatus: vi.fn(async () => ({ queued: 0, running: 0, lastJobCompletedAt: null })),
  listJobs: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0, hasMore: false })),
  notifyJobQueued: vi.fn(async () => undefined),
  retryJob: vi.fn(async () => ({ original: { ...okJob, status: "failed" }, retried: okJob }))
}));

vi.mock("../src/services/recoveryCenter.js", () => ({
  createBackupTarget: vi.fn(async () => ({ id: "target" })),
  createMigrationPlan: vi.fn(async () => ({ id: "migration" })),
  createRecoveryPoint: vi.fn(async () => ({ id: "point", hostId, appIdentity: {} })),
  createRecoveryPointWithJob: vi.fn(async () => ({ point: { id: "point", hostId, appIdentity: {} }, job: okJob })),
  createRecoverySchedule: vi.fn(async () => ({ id: "schedule", hostId })),
  deleteBackupTarget: vi.fn(async () => ({ id: "target" })),
  deleteRecoveryPoint: vi.fn(async () => ({ id: "point", hostId })),
  deleteRecoverySchedule: vi.fn(async () => undefined),
  enqueueRecoveryCreate: vi.fn(async () => okJob),
  enqueueRecoveryDrill: vi.fn(async () => ({ point: { id: "point", hostId }, job: okJob })),
  enqueueRecoveryRestore: vi.fn(async () => okJob),
  enqueueRecoveryVerify: vi.fn(async () => okJob),
  getBackupTarget: vi.fn(async () => ({ id: "target" })),
  getMigrationRun: vi.fn(async () => ({ id: "migration" })),
  getRecoveryPoint: vi.fn(async () => ({ id: "point", hostId, appIdentity: {} })),
  listBackupTargets: vi.fn(async () => []),
  listMigrationRuns: vi.fn(async () => []),
  listRecoveryPoints: vi.fn(async () => []),
  listRecoverySchedules: vi.fn(async () => []),
  startMigrationExecute: vi.fn(async () => ({ run: { id: "migration" }, job: okJob })),
  updateBackupTarget: vi.fn(async () => ({ id: "target" }))
}));

vi.mock("../src/services/recoveryReadiness.js", () => ({
  analyzeRecoveryReadiness: vi.fn(async () => ({ id: "readiness" })),
  listRecoveryReadiness: vi.fn(async () => [])
}));

vi.mock("../src/services/files.js", () => ({
  listHostDirectory: vi.fn(async () => ({ path: "/", entries: [] })),
  normalizeRemotePath: (value: string) => value,
  readHostTextFile: vi.fn(async () => ({ path: "/etc/hosts", content: "" })),
  statHostPath: vi.fn(async () => ({ path: "/tmp/test", exists: false, type: null, size: null })),
  writeHostTextFile: vi.fn(async () => ({ path: "/tmp/test", content: "" }))
}));

vi.mock("../src/services/registries.js", () => ({
  createRegistry: vi.fn(async () => ({ id: "registry" })),
  deleteRegistry: vi.fn(async () => undefined),
  listRegistries: vi.fn(async () => [])
}));

vi.mock("../src/services/users.js", () => ({
  createUser: vi.fn(async () => ({ id: "user" })),
  deleteUser: vi.fn(async () => undefined),
  listUsers: vi.fn(async () => []),
  updateUser: vi.fn(async () => ({ id: "user" }))
}));

vi.mock("../src/services/configBackup.js", () => ({
  exportConfigBackup: vi.fn(async () => "encrypted-backup"),
  importConfigBackup: vi.fn(async () => ({ imported: {} }))
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: vi.fn(async () => ({ public: { tags: [], connectionMode: "ssh" } }))
}));

vi.mock("../src/services/ssh.js", () => ({
  openSshShell: vi.fn()
}));

const { registerAlertRoutes } = await import("../src/routes/alerts.js");
const { registerAuditRoutes } = await import("../src/routes/audit.js");
const { registerBackupRoutes } = await import("../src/routes/backups.js");
const { registerConfigRoutes } = await import("../src/routes/config.js");
const { registerContainerRoutes } = await import("../src/routes/containers.js");
const { registerFileRoutes } = await import("../src/routes/files.js");
const { registerHostTerminalRoutes } = await import("../src/routes/hostTerminal.js");
const { registerJobRoutes } = await import("../src/routes/jobs.js");
const { registerRecoveryCenterRoutes } = await import("../src/routes/recoveryCenter.js");
const { registerRegistryRoutes } = await import("../src/routes/registries.js");
const { registerUserRoutes } = await import("../src/routes/users.js");

type Role = "viewer" | "operator" | "admin" | "owner";

async function buildApp() {
  const app = Fastify();
  await registerAlertRoutes(app);
  await registerAuditRoutes(app);
  await registerBackupRoutes(app);
  await registerConfigRoutes(app);
  await registerContainerRoutes(app);
  await registerFileRoutes(app);
  await registerHostTerminalRoutes(app);
  await registerJobRoutes(app);
  await registerRecoveryCenterRoutes(app);
  await registerRegistryRoutes(app);
  await registerUserRoutes(app);
  return app;
}

async function injectAs(app: Awaited<ReturnType<typeof buildApp>>, role: Role, options: Parameters<typeof app.inject>[0]) {
  currentRole.value = role;
  return app.inject(options);
}

describe("RBAC matrix route behavior", () => {
  beforeEach(() => {
    currentRole.value = "viewer";
    execInContainer.mockReset();
    execInContainer.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    writeAuditEvent.mockClear();
    transactionQuery.mockReset();
  });

  it("records container exec without retaining the command text in audit details", async () => {
    const app = await buildApp();
    const sensitiveCommand = "sh -c 'export TOKEN=qualification-secret'";
    try {
      const response = await injectAs(app, "operator", {
        method: "POST",
        url: `/api/hosts/${hostId}/containers/web/exec`,
        payload: { command: sensitiveCommand }
      });
      expect(response.statusCode).toBe(200);
      const event = writeAuditEvent.mock.calls.find(([input]) => input.action === "container.exec")?.[0];
      expect(event).toMatchObject({
        hostId,
        targetId: "web",
        details: { commandRedacted: true }
      });
      expect(JSON.stringify(event)).not.toContain(sensitiveCommand);
      expect(JSON.stringify(event)).not.toContain("qualification-secret");
    } finally {
      await app.close();
    }
  });

  it("records a redacted container exec attempt even when execution fails", async () => {
    const app = await buildApp();
    const sensitiveCommand = "sh -c 'export TOKEN=failed-qualification-secret'";
    execInContainer.mockRejectedValueOnce(new Error("Docker exec rejected the request"));
    try {
      const response = await injectAs(app, "operator", {
        method: "POST",
        url: `/api/hosts/${hostId}/containers/web/exec`,
        payload: { command: sensitiveCommand }
      });
      expect(response.statusCode).toBe(500);
      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        hostId,
        action: "container.exec",
        targetKind: "container",
        targetId: "web",
        details: { commandRedacted: true }
      }));
      expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain(sensitiveCommand);
      expect(JSON.stringify(writeAuditEvent.mock.calls)).not.toContain("failed-qualification-secret");
    } finally {
      await app.close();
    }
  });

  it("audits clone jobs without retaining user-supplied volume or target names", async () => {
    const app = await buildApp();
    const sensitiveVolumeName = "source-qualification-secret";
    const sensitiveTargetVolumeName = "target-qualification-secret";
    const sensitiveContainerName = "container-qualification-secret";
    try {
      const volumeResponse = await injectAs(app, "operator", {
        method: "POST",
        url: "/api/migrations/volume-clone",
        payload: {
          sourceHostId: hostId,
          targetHostId,
          sourceVolumeName: sensitiveVolumeName,
          targetVolumeName: sensitiveTargetVolumeName,
          overwrite: true
        }
      });
      expect(volumeResponse.statusCode).toBe(200);

      const containerResponse = await injectAs(app, "operator", {
        method: "POST",
        url: "/api/migrations/container-clone",
        payload: {
          sourceHostId: hostId,
          targetHostId,
          containerId: "source-web",
          targetName: sensitiveContainerName,
          start: true
        }
      });
      expect(containerResponse.statusCode).toBe(200);

      const volumeEvent = writeAuditEvent.mock.calls.find(([input]) => input.action === "volume.clone")?.[0];
      expect(volumeEvent).toMatchObject({
        userId,
        hostId,
        action: "volume.clone",
        targetKind: "backup",
        targetId: backupId,
        details: { targetHostId, overwrite: true }
      });
      const containerEvent = writeAuditEvent.mock.calls.find(([input]) => input.action === "container.clone")?.[0];
      expect(containerEvent).toMatchObject({
        userId,
        hostId,
        action: "container.clone",
        targetKind: "container",
        targetId: "source-web",
        details: { targetHostId, start: true }
      });
      const auditJson = JSON.stringify([volumeEvent, containerEvent]);
      expect(auditJson).not.toContain(sensitiveVolumeName);
      expect(auditJson).not.toContain(sensitiveTargetVolumeName);
      expect(auditJson).not.toContain(sensitiveContainerName);
      expect(auditJson).not.toContain("qualification-secret");
    } finally {
      await app.close();
    }
  });

  it("audits recovery verification when its job is created", async () => {
    const app = await buildApp();
    try {
      const response = await injectAs(app, "operator", {
        method: "POST",
        url: "/api/recovery/points/point/verify"
      });
      expect(response.statusCode).toBe(200);
      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        hostId,
        action: "recovery.verify",
        targetKind: "recovery_point",
        targetId: "point",
        ipAddress: "127.0.0.1",
        userAgent: "test"
      }), expect.anything());
    } finally {
      await app.close();
    }
  });

  it("audits alert channel and rule deletions using identifiers only", async () => {
    const app = await buildApp();
    try {
      expect((await injectAs(app, "operator", {
        method: "DELETE",
        url: `/api/alerts/channels/${channelId}`
      })).statusCode).toBe(200);
      expect((await injectAs(app, "operator", {
        method: "DELETE",
        url: `/api/alerts/rules/${ruleId}`
      })).statusCode).toBe(200);

      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        action: "alert.channel.delete",
        targetKind: "notification_channel",
        targetId: channelId,
        ipAddress: "127.0.0.1",
        userAgent: "test"
      }), expect.anything());
      expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId,
        action: "alert.rule.delete",
        targetKind: "alert_rule",
        targetId: ruleId,
        ipAddress: "127.0.0.1",
        userAgent: "test"
      }), expect.anything());
    } finally {
      await app.close();
    }
  });

  it("keeps viewer-readable operational surfaces accessible", async () => {
    const app = await buildApp();
    try {
      const routes = [
        "/api/alerts/history",
        "/api/alerts/silences",
        "/api/alerts/channels/test-history",
        `/api/hosts/${hostId}/containers/web/logs`,
        `/api/hosts/${hostId}/containers/web/inspect`,
        "/api/backups",
        "/api/backups/health",
        "/api/recovery/points",
        "/api/recovery/readiness",
        "/api/jobs",
        `/api/jobs/${jobId}`
      ];
      for (const url of routes) {
        const response = await injectAs(app, "viewer", { method: "GET", url });
        expect(response.statusCode, url).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("blocks viewers from operator-only operations and allows operators/admins/owners", async () => {
    const app = await buildApp();
    try {
      const routes = [
        { method: "POST" as const, url: "/api/alerts/channels", payload: { name: "Ops", type: "email", emailTo: "ops@example.com", enabled: true } },
        { method: "POST" as const, url: `/api/hosts/${hostId}/containers/web/exec`, payload: { command: "id" } },
        { method: "GET" as const, url: `/api/backups/${backupId}/download` },
        { method: "GET" as const, url: "/api/recovery/schedules" },
        { method: "GET" as const, url: `/api/hosts/${hostId}/files` },
        { method: "GET" as const, url: "/api/registries" },
        { method: "POST" as const, url: `/api/jobs/${jobId}/cancel` }
      ];
      for (const route of routes) {
        expect((await injectAs(app, "viewer", route)).statusCode, route.url).toBe(403);
        for (const role of ["operator", "admin", "owner"] as Role[]) {
          const statusCode = (await injectAs(app, role, route)).statusCode;
          expect(statusCode, `${role} ${route.url}`).not.toBe(403);
        }
      }
    } finally {
      await app.close();
    }
  });

  it("keeps admin-only platform routes out of operator reach", async () => {
    const app = await buildApp();
    try {
      const routes = [
        { method: "GET" as const, url: "/api/audit" },
        { method: "GET" as const, url: "/api/users" },
        { method: "POST" as const, url: "/api/config/export", payload: { passphrase: "long-enough-passphrase" } },
        { method: "GET" as const, url: `/api/hosts/${hostId}/terminal` }
      ];
      for (const route of routes) {
        expect((await injectAs(app, "viewer", route)).statusCode, route.url).toBe(403);
        expect((await injectAs(app, "operator", route)).statusCode, route.url).toBe(403);
        for (const role of ["admin", "owner"] as Role[]) {
          const statusCode = (await injectAs(app, role, route)).statusCode;
          expect(statusCode, `${role} ${route.url}`).not.toBe(403);
        }
      }
    } finally {
      await app.close();
    }
  });
});
