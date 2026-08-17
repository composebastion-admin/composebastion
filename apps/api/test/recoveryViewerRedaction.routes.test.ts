import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentRole = vi.hoisted(() => ({ value: "viewer" }));
const analyzeRecovery = vi.hoisted(() => vi.fn());
const analyzeRecoveryReadiness = vi.hoisted(() => vi.fn());
const listRecoveryReadiness = vi.hoisted(() => vi.fn());
const getRecoveryProfile = vi.hoisted(() => vi.fn());
const getRecoveryProfileForApp = vi.hoisted(() => vi.fn());
const listRecoveryPoints = vi.hoisted(() => vi.fn());
const getRecoveryPoint = vi.hoisted(() => vi.fn());
const listBackupTargets = vi.hoisted(() => vi.fn());
const getBackupTarget = vi.hoisted(() => vi.fn());
const listMigrationRuns = vi.hoisted(() => vi.fn());
const getMigrationRun = vi.hoisted(() => vi.fn());
const auditContextFromRequest = vi.hoisted(() => vi.fn(() => ({
  ipAddress: "198.51.100.10",
  userAgent: "qualification-test-agent"
})));
const writeAuditEvent = vi.hoisted(() => vi.fn());

const userId = "00000000-0000-4000-8000-000000000101";
const hostId = "00000000-0000-4000-8000-000000000102";
const stackId = "00000000-0000-4000-8000-000000000103";
const profileId = "00000000-0000-4000-8000-000000000104";
const pointId = "00000000-0000-4000-8000-000000000105";
const targetId = "00000000-0000-4000-8000-000000000106";
const migrationRunId = "00000000-0000-4000-8000-000000000108";
const includePath = "/srv/private/tenant-a/database";
const detachedIncludePath = "/srv/private/tenant-a/detached";
const excludePattern = "/srv/tenant-a/private/**";
const restorePath = "/restore/private/tenant-a/database";
const hookCanary = "viewer-hook-command-canary";
const diagnosticCanary = "viewer-readiness-diagnostic-canary";
const rawDiagnosticCanary = "viewer-raw-non-url-diagnostic-canary";
const migrationDiagnosticCanary = "viewer-migration-arbitrary-canary";
const migrationUrlSecret = "viewer-migration-url-secret";
const migrationPrivatePath = "/srv/private/tenant-a/migration";
const unsafeDiagnostic =
  `failed https://worker:${diagnosticCanary}@worker.example.test/recovery`;
const unsafeMigrationUrl =
  `https://migration-user:${migrationUrlSecret}@worker.example.test/run?token=${migrationUrlSecret}`;
const now = "2026-07-30T10:00:00.000Z";
const appIdentity = {
  kind: "stack" as const,
  stackId,
  projectName: "tenant-a",
  label: "Tenant A"
};

function profile() {
  return {
    id: profileId,
    hostId,
    appIdentity,
    name: "Tenant A",
    includePaths: [includePath, detachedIncludePath],
    excludePatterns: [excludePattern],
    restorePaths: { [includePath]: restorePath },
    preCaptureCommand: `printf ${hookCanary}`,
    postCaptureCommand: `curl https://user:${hookCanary}@hooks.example.test/done`,
    captureMode: "stop_first" as const,
    createdAt: now,
    updatedAt: now
  };
}

function analysis() {
  return {
    hostId,
    appIdentity,
    profile: profile(),
    status: "warning" as const,
    recommendedCaptureMode: "stop_first" as const,
    dataMounts: [
      {
        type: "manual" as const,
        containerName: null,
        source: includePath,
        name: null,
        destination: "",
        readOnly: false,
        included: true,
        warning: null
      },
      {
        type: "bind" as const,
        containerName: "web",
        source: "/srv/public-data",
        name: null,
        destination: "/data",
        readOnly: false,
        included: true,
        warning: null
      }
    ],
    volumes: [],
    bindMounts: [includePath, "/srv/public-data"],
    warnings: [`Manual recovery source ${includePath}`],
    blockingIssues: []
  };
}

function readiness() {
  return {
    hostId,
    appIdentity,
    label: "Tenant A",
    status: "risky" as const,
    score: 50,
    reasons: [
      {
        code: "host_path_blocked",
        severity: "critical" as const,
        message: `Recovery source path ${includePath} is blocked`,
        action: `Move ${includePath} under an allowed root.`
      },
      {
        code: "target_health_failed",
        severity: "warning" as const,
        message: `${unsafeDiagnostic}; ${rawDiagnosticCanary}`,
        action: `Repair the target after reviewing ${rawDiagnosticCanary}.`
      }
    ],
    recommendedCaptureMode: "stop_first" as const,
    lastRecoveryPoint: {
      id: pointId,
      status: "failed" as const,
      createdAt: now,
      completedAt: now,
      verified: false,
      artifactCount: 1,
      completedArtifactCount: 0,
      backupTargetId: targetId,
      localUsable: false,
      remoteUsable: false,
      error: `${unsafeDiagnostic}; source ${detachedIncludePath}; ${rawDiagnosticCanary}`
    },
    lastDrill: {
      lastDrillAt: now,
      lastDrillStatus: "failed",
      lastDrillError: `${unsafeDiagnostic}; ${rawDiagnosticCanary}`,
      lastSuccessfulDrillAt: null,
      passed: false
    },
    profile: profile(),
    targetHealth: {
      targetId,
      targetName: "Private target",
      status: "failed" as const,
      checkedAt: now,
      error: `${unsafeDiagnostic}; ${rawDiagnosticCanary}`
    },
    dataMounts: analysis().dataMounts
  };
}

function recoveryPoint() {
  const artifactPath = "host_folder/srv_private_tenant-a_database.tar.gz";
  return {
    id: pointId,
    hostId,
    name: "Tenant A point",
    appIdentity,
    triggerKind: "manual" as const,
    status: "partial" as const,
    backupTargetId: targetId,
    legacyVolumeBackupId: null,
    profileId,
    artifactCount: 1,
    completedArtifactCount: 1,
    remoteArtifactCount: 1,
    remoteUploadFailureCount: 0,
    localRetainedArtifactCount: 1,
    localRemovedArtifactCount: 0,
    totalBytes: 1024,
    error: `hook failed with bearer ${hookCanary}`,
    metadata: {
      extraIncludePaths: [detachedIncludePath],
      profileSnapshot: profile(),
      preCaptureHook: { stdout: `Bearer ${hookCanary}`, stderr: "" },
      postCaptureHook: { stdout: "", stderr: `token=${hookCanary}` },
      verifiedAt: now,
      remoteUploadComplete: true,
      remoteUploadArtifactCount: 1,
      remoteVerifiedArtifactCount: 1,
      remoteObjectKeys: [`points/${pointId}/${artifactPath}`]
    },
    lastDrillAt: now,
    lastDrillStatus: "failed",
    lastDrillError: `drill failed for ${includePath}`,
    lastSuccessfulDrillAt: null,
    createdAt: now,
    startedAt: now,
    completedAt: now,
    artifacts: [{
      id: "00000000-0000-4000-8000-000000000107",
      recoveryPointId: pointId,
      kind: "host_folder" as const,
      backupTargetId: targetId,
      storageKey: artifactPath,
      sizeBytes: 1024,
      checksum: "sha256:abc",
      status: "partial" as const,
      error: `capture failed for ${restorePath}`,
      metadata: {
        sourcePath: includePath,
        restorePath,
        excludePatterns: ["*.private"],
        remoteObjectKey: `points/${pointId}/${artifactPath}`
      },
      createdAt: now,
      completedAt: now
    }]
  };
}

function backupTarget() {
  return {
    id: targetId,
    name: "Private target",
    type: "s3" as const,
    kind: "s3" as const,
    enabled: true,
    config: {},
    endpoint: "https://s3.example.test",
    region: null,
    bucket: "recovery",
    prefix: null,
    forcePathStyle: true,
    basePath: null,
    provider: null,
    rcloneProvider: null,
    remotePath: null,
    remoteName: null,
    localCachePolicy: "keep" as const,
    healthStatus: "failed" as const,
    healthCheckedAt: now,
    healthError: unsafeDiagnostic,
    hasCredentials: true,
    hasSecretAccessKey: true,
    hasGenericConfig: false,
    hasGenericCredentials: false,
    accessKeyId: "ACCESS",
    createdAt: now,
    updatedAt: now
  };
}

function migrationRun() {
  return {
    id: migrationRunId,
    planRunId: null,
    sourceHostId: hostId,
    targetHostId: "00000000-0000-4000-8000-000000000109",
    sourceAppIdentity: {
      ...appIdentity,
      label: migrationDiagnosticCanary
    },
    mode: "execute" as const,
    status: "failed" as const,
    recoveryPointId: pointId,
    plan: {
      sourceHostId: hostId,
      targetHostId: "00000000-0000-4000-8000-000000000109",
      sourceAppIdentity: {
        ...appIdentity,
        label: migrationDiagnosticCanary
      },
      intent: {
        strategy: "safe_move" as const,
        options: {
          stopSource: true,
          projectNameOverride: migrationDiagnosticCanary,
          remapPorts: false,
          networkMode: "reuse" as const
        }
      },
      sourceFingerprint: "a".repeat(64),
      targetFingerprint: "b".repeat(64),
      steps: [{
        id: migrationDiagnosticCanary,
        title: migrationDiagnosticCanary,
        description: unsafeMigrationUrl,
        kind: "deploy" as const,
        required: true
      }],
      warnings: [
        `${migrationDiagnosticCanary} at ${migrationPrivatePath}`,
        unsafeMigrationUrl
      ],
      estimatedArtifacts: 4,
      estimatedVolumes: 2,
      estimatedHostFolders: 1,
      checks: {
        sourceHostAvailable: true,
        targetHostAvailable: true,
        sourceDockerAvailable: true,
        targetDockerAvailable: true,
        sourceComposeAvailable: true,
        targetComposeAvailable: false
      },
      portConflicts: [{
        hostPort: "8443",
        protocol: "tcp",
        sourceContainer: migrationDiagnosticCanary,
        reason: `${migrationDiagnosticCanary} at ${migrationPrivatePath}`
      }],
      volumeCollisions: [`volume-${migrationDiagnosticCanary}`],
      nameCollisions: [`container-${migrationDiagnosticCanary}`],
      missingNetworks: [`network-${migrationDiagnosticCanary}`],
      networkConflicts: [`${migrationDiagnosticCanary} at ${migrationPrivatePath}`],
      estimatedDataBytes: 4096,
      blockingIssues: [`${migrationDiagnosticCanary} at ${migrationPrivatePath}`]
    },
    error: `${migrationDiagnosticCanary}: ${unsafeMigrationUrl}; ${migrationPrivatePath}`,
    createdAt: now,
    startedAt: now,
    completedAt: now
  };
}

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
  auditContextFromRequest,
  writeAuditEvent
}));

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/recoveryCenter.js", () => ({
  createBackupTarget: vi.fn(),
  createMigrationPlan: vi.fn(),
  createRecoveryPointWithJob: vi.fn(),
  createRecoverySchedule: vi.fn(),
  deleteBackupTarget: vi.fn(),
  deleteRecoveryPoint: vi.fn(),
  deleteRecoverySchedule: vi.fn(),
  enqueueRecoveryDrill: vi.fn(),
  enqueueRecoveryRestore: vi.fn(),
  getBackupTarget: (...args: unknown[]) => getBackupTarget(...args),
  getMigrationRun: (...args: unknown[]) => getMigrationRun(...args),
  getRecoveryPoint: (...args: unknown[]) => getRecoveryPoint(...args),
  listBackupTargets: (...args: unknown[]) => listBackupTargets(...args),
  listMigrationRuns: (...args: unknown[]) => listMigrationRuns(...args),
  listRecoveryPoints: (...args: unknown[]) => listRecoveryPoints(...args),
  listRecoverySchedules: vi.fn(),
  MigrationPlanStaleError: class MigrationPlanStaleError extends Error {},
  startMigrationExecute: vi.fn(),
  testBackupTarget: vi.fn(),
  updateBackupTarget: vi.fn()
}));

vi.mock("../src/services/recoveryAnalysis.js", () => ({
  analyzeRecovery: (...args: unknown[]) => analyzeRecovery(...args)
}));

vi.mock("../src/services/recoveryProfiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/recoveryProfiles.js")>();
  return {
    ...actual,
    getRecoveryProfile: (...args: unknown[]) => getRecoveryProfile(...args),
    getRecoveryProfileForApp: (...args: unknown[]) => getRecoveryProfileForApp(...args),
    upsertRecoveryProfile: vi.fn(),
    deleteRecoveryProfile: vi.fn()
  };
});

vi.mock("../src/services/recoveryReadiness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/recoveryReadiness.js")>();
  return {
    ...actual,
    analyzeRecoveryReadiness: (...args: unknown[]) => analyzeRecoveryReadiness(...args),
    listRecoveryReadiness: (...args: unknown[]) => listRecoveryReadiness(...args)
  };
});

const { registerRecoveryCenterRoutes } = await import("../src/routes/recoveryCenter.js");

async function buildApp() {
  const app = Fastify();
  await registerRecoveryCenterRoutes(app);
  return app;
}

async function profileResponses(
  app: Awaited<ReturnType<typeof buildApp>>,
  role: "viewer" | "operator" | "admin" | "owner"
) {
  currentRole.value = role;
  const lookup = await app.inject({
    method: "POST",
    url: "/api/recovery/profiles/lookup",
    payload: { hostId, appIdentity }
  });
  const byId = await app.inject({
    method: "GET",
    url: `/api/recovery/profiles/${profileId}`
  });
  return [lookup, byId];
}

async function analysisResponses(
  app: Awaited<ReturnType<typeof buildApp>>,
  role: "viewer" | "operator" | "admin" | "owner"
) {
  currentRole.value = role;
  const analyzed = await app.inject({
    method: "POST",
    url: "/api/recovery/analyze",
    payload: { hostId, appIdentity }
  });
  const listed = await app.inject({
    method: "GET",
    url: `/api/recovery/readiness?hostId=${hostId}`
  });
  const readinessAnalyzed = await app.inject({
    method: "POST",
    url: "/api/recovery/readiness/analyze",
    payload: { hostId, appIdentity }
  });
  return { analyzed, listed, readinessAnalyzed };
}

async function storedRecoveryResponses(
  app: Awaited<ReturnType<typeof buildApp>>,
  role: "viewer" | "operator" | "admin" | "owner"
) {
  currentRole.value = role;
  const points = await app.inject({ method: "GET", url: "/api/recovery/points" });
  const point = await app.inject({ method: "GET", url: `/api/recovery/points/${pointId}` });
  const targets = await app.inject({ method: "GET", url: "/api/recovery/targets" });
  const target = await app.inject({ method: "GET", url: `/api/recovery/targets/${targetId}` });
  return { points, point, targets, target };
}

async function migrationResponses(
  app: Awaited<ReturnType<typeof buildApp>>,
  role: "viewer" | "operator" | "admin" | "owner"
) {
  currentRole.value = role;
  const runs = await app.inject({ method: "GET", url: "/api/recovery/migrations" });
  const run = await app.inject({
    method: "GET",
    url: `/api/recovery/migrations/${migrationRunId}`
  });
  return { runs, run };
}

describe("viewer recovery definition redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRole.value = "viewer";
    analyzeRecovery.mockResolvedValue(analysis());
    analyzeRecoveryReadiness.mockResolvedValue(readiness());
    listRecoveryReadiness.mockResolvedValue([readiness()]);
    getRecoveryProfile.mockResolvedValue(profile());
    getRecoveryProfileForApp.mockResolvedValue(profile());
    const { artifacts: _artifacts, ...listedPoint } = recoveryPoint();
    listRecoveryPoints.mockResolvedValue([listedPoint]);
    getRecoveryPoint.mockResolvedValue(recoveryPoint());
    listBackupTargets.mockResolvedValue([backupTarget()]);
    getBackupTarget.mockResolvedValue(backupTarget());
    listMigrationRuns.mockResolvedValue([migrationRun()]);
    getMigrationRun.mockResolvedValue(migrationRun());
  });

  it("records sanitized success correlation for analysis, readiness, and profile lookup", async () => {
    const app = await buildApp();
    try {
      for (const url of [
        "/api/recovery/analyze",
        "/api/recovery/readiness/analyze",
        "/api/recovery/profiles/lookup"
      ]) {
        const response = await app.inject({
          method: "POST",
          url,
          payload: { hostId, appIdentity }
        });
        expect(response.statusCode).toBe(200);
      }

      const commonAudit = {
        userId,
        hostId,
        targetKind: "recovery_app",
        targetId: stackId,
        ipAddress: "198.51.100.10",
        userAgent: "qualification-test-agent"
      };
      expect(writeAuditEvent).toHaveBeenNthCalledWith(1, {
        ...commonAudit,
        action: "recovery.analyze",
        details: {
          appKind: "stack",
          stackId,
          profileId,
          status: "warning"
        }
      });
      expect(writeAuditEvent).toHaveBeenNthCalledWith(2, {
        ...commonAudit,
        action: "recovery.readiness.analyze",
        details: {
          appKind: "stack",
          stackId,
          profileId,
          status: "risky"
        }
      });
      expect(writeAuditEvent).toHaveBeenNthCalledWith(3, {
        ...commonAudit,
        action: "recovery.profile.lookup",
        details: {
          appKind: "stack",
          stackId,
          profileId,
          status: "found"
        }
      });
      expect(auditContextFromRequest).toHaveBeenCalledTimes(3);
      const serializedAudit = JSON.stringify(writeAuditEvent.mock.calls);
      expect(serializedAudit).not.toContain("Tenant A");
      expect(serializedAudit).not.toContain(includePath);
      expect(serializedAudit).not.toContain(detachedIncludePath);
      expect(serializedAudit).not.toContain(hookCanary);
      expect(serializedAudit).not.toContain(rawDiagnosticCanary);
    } finally {
      await app.close();
    }
  });

  it.each([
    "/api/recovery/analyze",
    "/api/recovery/readiness/analyze",
    "/api/recovery/profiles/lookup"
  ])("does not audit invalid input for %s", async (url) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url,
        payload: {
          hostId: "not-a-host-id",
          appIdentity: { kind: "stack", stackId: "not-a-stack-id" }
        }
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(writeAuditEvent).not.toHaveBeenCalled();
      expect(auditContextFromRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not audit a denied recovery analysis request", async () => {
    currentRole.value = "denied";
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/recovery/analyze",
        payload: { hostId, appIdentity }
      });
      expect(response.statusCode).toBe(403);
      expect(analyzeRecovery).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
      expect(auditContextFromRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("redacts both viewer profile reads without changing their response shape", async () => {
    const app = await buildApp();
    try {
      for (const response of await profileResponses(app, "viewer")) {
        expect(response.statusCode).toBe(200);
        expect(response.json().profile).toMatchObject({
          includePaths: [],
          excludePatterns: [],
          restorePaths: {},
          preCaptureCommand: null,
          postCaptureCommand: null,
          sensitiveFieldsRedacted: true
        });
        expect(response.body).not.toContain(includePath);
        expect(response.body).not.toContain(detachedIncludePath);
        expect(response.body).not.toContain(excludePattern);
        expect(response.body).not.toContain(restorePath);
        expect(response.body).not.toContain(hookCanary);
      }
    } finally {
      await app.close();
    }
  });

  it("redacts viewer analysis and both readiness surfaces", async () => {
    const app = await buildApp();
    try {
      const responses = await analysisResponses(app, "viewer");
      expect(responses.analyzed.statusCode).toBe(200);
      const outwardAnalysis = responses.analyzed.json().analysis;
      expect(outwardAnalysis.profile.sensitiveFieldsRedacted).toBe(true);
      expect(outwardAnalysis.dataMounts[0].source).toBeNull();
      expect(outwardAnalysis.bindMounts).toEqual(["/srv/public-data"]);
      expect(responses.analyzed.body).not.toContain(includePath);
      expect(responses.analyzed.body).not.toContain(detachedIncludePath);
      expect(responses.analyzed.body).not.toContain(excludePattern);
      expect(responses.analyzed.body).not.toContain(restorePath);
      expect(responses.analyzed.body).not.toContain(hookCanary);

      for (const response of [responses.listed, responses.readinessAnalyzed]) {
        expect(response.statusCode).toBe(200);
        const outward = response.json().readiness;
        const item = Array.isArray(outward) ? outward[0] : outward;
        expect(item.profile.sensitiveFieldsRedacted).toBe(true);
        expect(item.dataMounts[0].source).toBeNull();
        expect(item.reasons.find((reason: any) => reason.code === "host_path_blocked").message)
          .toBe("A configured recovery source path is blocked by recovery path safety rules.");
        expect(response.body).not.toContain(includePath);
        expect(response.body).not.toContain(detachedIncludePath);
        expect(response.body).not.toContain(excludePattern);
        expect(response.body).not.toContain(restorePath);
        expect(response.body).not.toContain(hookCanary);
        expect(response.body).not.toContain(diagnosticCanary);
        expect(response.body).not.toContain(rawDiagnosticCanary);
      }
    } finally {
      await app.close();
    }
  });

  it("redacts persisted recovery definitions, hook output, artifact paths, and target diagnostics for viewers", async () => {
    const app = await buildApp();
    try {
      const responses = await storedRecoveryResponses(app, "viewer");
      for (const response of Object.values(responses)) {
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(includePath);
        expect(response.body).not.toContain(detachedIncludePath);
        expect(response.body).not.toContain(restorePath);
        expect(response.body).not.toContain(hookCanary);
        expect(response.body).not.toContain(diagnosticCanary);
      }

      const listedPoint = responses.points.json().points[0];
      expect(listedPoint.metadata).toEqual({
        sensitiveFieldsRedacted: true,
        remoteUploadComplete: true,
        remoteUploadArtifactCount: 1,
        remoteVerifiedArtifactCount: 1,
        verifiedAt: now
      });
      expect(listedPoint.error).toMatch(/operators and administrators/);
      expect(listedPoint.lastDrillError).toMatch(/operators and administrators/);

      const detail = responses.point.json().point;
      expect(detail.artifacts[0]).toMatchObject({
        storageKey: "host_folder-artifact-1",
        error: expect.stringMatching(/operators and administrators/),
        metadata: { sensitiveFieldsRedacted: true }
      });
      expect(responses.targets.json().targets[0].healthError)
        .toMatch(/operators and administrators/);
      expect(responses.target.json().target.healthError)
        .toMatch(/operators and administrators/);
      expect(responses.targets.json().targets[0].accessKeyId).toBeNull();
      expect(responses.target.json().target.accessKeyId).toBeNull();
      expect(responses.targets.body).not.toContain("ACCESS");
      expect(responses.target.body).not.toContain("ACCESS");
    } finally {
      await app.close();
    }
  });

  it("fails closed on arbitrary migration diagnostics in both viewer list and detail reads", async () => {
    const app = await buildApp();
    try {
      const responses = await migrationResponses(app, "viewer");
      for (const response of Object.values(responses)) {
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(migrationDiagnosticCanary);
        expect(response.body).not.toContain(migrationUrlSecret);
        expect(response.body).not.toContain(migrationPrivatePath);
      }

      const listed = responses.runs.json().runs[0];
      const detailed = responses.run.json().run;
      for (const outward of [listed, detailed]) {
        expect(outward).toMatchObject({
          mode: "execute",
          status: "failed",
          createdAt: now,
          startedAt: now,
          completedAt: now,
          error: expect.stringMatching(/operators and administrators/),
          sourceAppIdentity: {
            kind: "stack",
            stackId
          },
          plan: {
            intent: {
              strategy: "safe_move",
              options: {
                stopSource: true,
                remapPorts: false,
                networkMode: "reuse"
              }
            },
            sourceFingerprint: null,
            targetFingerprint: null,
            estimatedArtifacts: 4,
            estimatedVolumes: 2,
            estimatedHostFolders: 1,
            estimatedDataBytes: 4096
          }
        });
        expect(outward.sourceAppIdentity).not.toHaveProperty("label");
        expect(outward.sourceAppIdentity).not.toHaveProperty("projectName");
        expect(outward.plan.intent.options).not.toHaveProperty("projectNameOverride");
        expect(outward.plan.warnings).toHaveLength(2);
        expect(outward.plan.portConflicts).toHaveLength(1);
        expect(outward.plan.volumeCollisions).toHaveLength(1);
        expect(outward.plan.nameCollisions).toHaveLength(1);
        expect(outward.plan.missingNetworks).toHaveLength(1);
        expect(outward.plan.networkConflicts).toHaveLength(1);
        expect(outward.plan.blockingIssues).toHaveLength(1);

        // This assertion covers the complete serialized object so a future
        // nested plan field cannot accidentally reflect arbitrary diagnostics.
        const serialized = JSON.stringify(outward);
        expect(serialized).not.toContain(migrationDiagnosticCanary);
        expect(serialized).not.toContain(migrationUrlSecret);
        expect(serialized).not.toContain(migrationPrivatePath);
      }
    } finally {
      await app.close();
    }
  });

  it.each(["operator", "admin", "owner"] as const)(
    "retains URL-sanitized migration diagnostics for %s",
    async (role) => {
      const app = await buildApp();
      try {
        const responses = await migrationResponses(app, role);
        for (const response of Object.values(responses)) {
          expect(response.statusCode).toBe(200);
          expect(response.body).toContain(migrationDiagnosticCanary);
          expect(response.body).toContain(migrationPrivatePath);
          expect(response.body).not.toContain(migrationUrlSecret);
          expect(response.body).toContain("worker.example.test/run");
        }
      } finally {
        await app.close();
      }
    }
  );

  it("retains persisted recovery and target diagnostics for operators", async () => {
    const app = await buildApp();
    try {
      const responses = await storedRecoveryResponses(app, "operator");
      for (const response of Object.values(responses)) {
        expect(response.statusCode).toBe(200);
      }
      expect(responses.points.body).toContain(detachedIncludePath);
      expect(responses.point.body).toContain(includePath);
      expect(responses.point.body).toContain(restorePath);
      expect(responses.point.body).toContain(hookCanary);
      expect(responses.targets.body).toContain(diagnosticCanary);
      expect(responses.target.body).toContain(diagnosticCanary);
    } finally {
      await app.close();
    }
  });

  it.each(["operator", "admin", "owner"] as const)(
    "retains full recovery definitions for %s",
    async (role) => {
      const app = await buildApp();
      try {
        for (const response of await profileResponses(app, role)) {
          expect(response.statusCode).toBe(200);
          expect(response.json().profile).toMatchObject({
            includePaths: [includePath, detachedIncludePath],
            restorePaths: { [includePath]: restorePath },
            preCaptureCommand: `printf ${hookCanary}`
          });
          expect(response.json().profile.sensitiveFieldsRedacted).toBeUndefined();
        }

        const responses = await analysisResponses(app, role);
        for (const response of [
          responses.analyzed,
          responses.listed,
          responses.readinessAnalyzed
        ]) {
          expect(response.statusCode).toBe(200);
          expect(response.body).toContain(includePath);
          expect(response.body).toContain(restorePath);
          expect(response.body).toContain(hookCanary);
          expect(response.body).not.toContain("sensitiveFieldsRedacted");
        }
        expect(responses.listed.body).toContain(rawDiagnosticCanary);
        expect(responses.readinessAnalyzed.body).toContain(rawDiagnosticCanary);
      } finally {
        await app.close();
      }
    }
  );
});
