import type { FastifyInstance } from "fastify";
import {
  backupTargetUpdateSchema,
  migrationExecuteRequestSchema,
  migrationPlanRequestSchema,
  recoveryAnalysisRequestSchema,
  recoveryReadinessAnalyzeRequestSchema,
  recoveryReadinessListQuerySchema,
  recoveryProfileInputSchema,
  recoveryPointCreateSchema,
  recoveryPointListQuerySchema,
  recoveryRestoreRequestSchema,
  type BackupTarget,
  type RecoveryAppIdentity,
  type RecoveryPointDetail,
  type RecoveryPointListItem
} from "@composebastion/shared";
import { requireRole } from "../services/auth.js";
import { sendApiError } from "../services/apiError.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import {
  createBackupTarget,
  createMigrationPlan,
  createRecoveryPointWithJob,
  createRecoverySchedule,
  deleteBackupTarget,
  deleteRecoveryPoint,
  deleteRecoverySchedule,
  enqueueRecoveryDrill,
  enqueueRecoveryRestore,
  enqueueRecoveryVerify,
  getBackupTarget,
  getMigrationRun,
  getRecoveryPoint,
  listBackupTargets,
  listMigrationRuns,
  listRecoveryPoints,
  listRecoverySchedules,
  MigrationPlanStaleError,
  startMigrationExecute,
  testBackupTarget,
  updateBackupTarget
} from "../services/recoveryCenter.js";
import { analyzeRecovery } from "../services/recoveryAnalysis.js";
import {
  deleteRecoveryProfile,
  getRecoveryProfile,
  getRecoveryProfileForApp,
  redactRecoveryProfileForViewer,
  upsertRecoveryProfile
} from "../services/recoveryProfiles.js";
import {
  analyzeRecoveryReadiness,
  listRecoveryReadiness,
  redactRecoveryAnalysisForViewer,
  redactRecoveryReadinessForViewer
} from "../services/recoveryReadiness.js";
import { authenticatedReadRateLimit, expensiveReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";
import {
  redactMigrationRunForViewer,
  sanitizeMigrationRunForRead,
  sanitizeRecoveryPointForRead
} from "../services/mappers.js";

const VIEWER_RECOVERY_ERROR =
  "Recovery operation details are available to operators and administrators.";
const VIEWER_TARGET_HEALTH_ERROR =
  "Backup target health details are available to operators and administrators.";

function viewerRecoveryMetadata(metadata: Record<string, unknown>) {
  const outward: Record<string, unknown> = { sensitiveFieldsRedacted: true };
  for (const key of [
    "remoteUploadNotApplicable",
    "remoteUploadComplete"
  ]) {
    if (typeof metadata[key] === "boolean") outward[key] = metadata[key];
  }
  for (const key of [
    "remoteUploadFailureCount",
    "remoteUploadArtifactCount",
    "remoteVerifiedArtifactCount"
  ]) {
    if (typeof metadata[key] === "number" && Number.isFinite(metadata[key])) {
      outward[key] = metadata[key];
    }
  }
  if (
    typeof metadata.verifiedAt === "string"
    && Number.isFinite(Date.parse(metadata.verifiedAt))
  ) {
    outward.verifiedAt = metadata.verifiedAt;
  }
  return outward;
}

function redactRecoveryPointForViewer<
  T extends RecoveryPointListItem | RecoveryPointDetail
>(point: T): T {
  const outward = {
    ...point,
    error: point.error ? VIEWER_RECOVERY_ERROR : null,
    lastDrillError: point.lastDrillError ? VIEWER_RECOVERY_ERROR : null,
    metadata: viewerRecoveryMetadata(point.metadata)
  };
  if (!("artifacts" in point)) return outward as T;
  return {
    ...outward,
    artifacts: point.artifacts.map((artifact, index) => ({
      ...artifact,
      storageKey: `${artifact.kind}-artifact-${index + 1}`,
      error: artifact.error ? VIEWER_RECOVERY_ERROR : null,
      metadata: { sensitiveFieldsRedacted: true }
    }))
  } as T;
}

function redactBackupTargetForViewer(target: BackupTarget): BackupTarget {
  return {
    ...target,
    accessKeyId: null,
    healthError: target.healthError ? VIEWER_TARGET_HEALTH_ERROR : null
  };
}

function recoveryAppAuditIdentity(appIdentity: RecoveryAppIdentity) {
  const targetId = appIdentity.kind === "stack"
    ? appIdentity.stackId
    : appIdentity.kind === "git"
      ? appIdentity.repositoryId
      : appIdentity.kind === "compose" && appIdentity.stackId
        ? appIdentity.stackId
        : null;
  const details: Record<string, unknown> = {
    appKind: appIdentity.kind
  };
  if (appIdentity.kind === "stack") details.stackId = appIdentity.stackId;
  if (appIdentity.kind === "git") {
    details.repositoryId = appIdentity.repositoryId;
  }
  if (appIdentity.kind === "compose" && appIdentity.stackId) {
    details.stackId = appIdentity.stackId;
  }
  if (appIdentity.kind === "standalone") {
    details.containerCount = appIdentity.containerIds.length;
  }
  return { targetId, details };
}

export async function registerRecoveryCenterRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/recovery/targets", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const targets = await listBackupTargets();
    return {
      targets: request.user?.role === "viewer"
        ? targets.map(redactBackupTargetForViewer)
        : targets
    };
  });

  app.post("/api/recovery/targets", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const auditContext = auditContextFromRequest(request);
    const target = await createBackupTarget(
      request.body,
      request.user?.id,
      async (client, created) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "recovery.target.create",
          targetKind: "backup_target",
          targetId: created.id,
          ...auditContext
        }, client);
      }
    );
    return { target };
  });

  app.patch("/api/recovery/targets/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const target = await updateBackupTarget(
      id,
      backupTargetUpdateSchema.parse(request.body),
      async (client, updated) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "recovery.target.update",
          targetKind: "backup_target",
          targetId: updated.id,
          ...auditContext
        }, client);
      }
    );
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    return { target };
  });

  app.delete("/api/recovery/targets/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const target = await deleteBackupTarget(id, async (client) => {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "recovery.target.delete",
        targetKind: "backup_target",
        targetId: id,
        ...auditContext
      }, client);
    });
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    return { ok: true };
  });

  app.post("/api/recovery/targets/:id/test", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await getBackupTarget(id);
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    const auditContext = auditContextFromRequest(request);
    const result = await testBackupTarget(id, async (client) => {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "recovery.target.test",
        targetKind: "backup_target",
        targetId: id,
        details: { phase: "requested" },
        ...auditContext
      }, client);
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/recovery/analyze", { preHandler: viewer, config: { rateLimit: expensiveReadRateLimit } }, async (request) => {
    const body = recoveryAnalysisRequestSchema.parse(request.body);
    const analysis = await analyzeRecovery(body);
    const auditedApp = recoveryAppAuditIdentity(body.appIdentity);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "recovery.analyze",
      targetKind: "recovery_app",
      targetId: auditedApp.targetId,
      details: {
        ...auditedApp.details,
        profileId: body.profileId ?? analysis.profile?.id ?? null,
        status: analysis.status
      },
      ...auditContextFromRequest(request)
    });
    return {
      analysis: request.user?.role === "viewer"
        ? redactRecoveryAnalysisForViewer(analysis)
        : analysis
    };
  });

  app.get("/api/recovery/readiness", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const query = recoveryReadinessListQuerySchema.parse(request.query ?? {});
    const readiness = await listRecoveryReadiness(query.hostId);
    return {
      readiness: request.user?.role === "viewer"
        ? readiness.map(redactRecoveryReadinessForViewer)
        : readiness
    };
  });

  app.post("/api/recovery/readiness/analyze", { preHandler: viewer, config: { rateLimit: expensiveReadRateLimit } }, async (request) => {
    const body = recoveryReadinessAnalyzeRequestSchema.parse(request.body);
    const readiness = await analyzeRecoveryReadiness(body);
    const auditedApp = recoveryAppAuditIdentity(body.appIdentity);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "recovery.readiness.analyze",
      targetKind: "recovery_app",
      targetId: auditedApp.targetId,
      details: {
        ...auditedApp.details,
        profileId: body.profileId ?? readiness.profile?.id ?? null,
        status: readiness.status
      },
      ...auditContextFromRequest(request)
    });
    return {
      readiness: request.user?.role === "viewer"
        ? redactRecoveryReadinessForViewer(readiness)
        : readiness
    };
  });

  app.post("/api/recovery/profiles/lookup", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const body = recoveryProfileInputSchema.pick({ hostId: true, appIdentity: true }).parse(request.body);
    const profile = await getRecoveryProfileForApp(body.hostId, body.appIdentity);
    const auditedApp = recoveryAppAuditIdentity(body.appIdentity);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "recovery.profile.lookup",
      targetKind: "recovery_app",
      targetId: auditedApp.targetId,
      details: {
        ...auditedApp.details,
        profileId: profile?.id ?? null,
        status: profile ? "found" : "not_found"
      },
      ...auditContextFromRequest(request)
    });
    return {
      profile: request.user?.role === "viewer"
        ? redactRecoveryProfileForViewer(profile)
        : profile
    };
  });

  app.put("/api/recovery/profiles", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const auditContext = auditContextFromRequest(request);
    const profile = await upsertRecoveryProfile(
      recoveryProfileInputSchema.parse(request.body),
      request.user?.id,
      async (client, upserted) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: upserted.hostId,
          action: "recovery.profile.upsert",
          targetKind: "recovery_profile",
          targetId: upserted.id,
          ...auditContext
        }, client);
      }
    );
    return { profile };
  });

  app.get("/api/recovery/profiles/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await getRecoveryProfile(id);
    if (!profile) {
      reply.code(404);
      return { error: "Recovery profile not found" };
    }
    return {
      profile: request.user?.role === "viewer"
        ? redactRecoveryProfileForViewer(profile)
        : profile
    };
  });

  app.delete("/api/recovery/profiles/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const profile = await deleteRecoveryProfile(id, async (client, deleted) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: deleted.hostId,
        action: "recovery.profile.delete",
        targetKind: "recovery_profile",
        targetId: id,
        ...auditContext
      }, client);
    });
    if (!profile) {
      reply.code(404);
      return { error: "Recovery profile not found" };
    }
    return { ok: true };
  });

  app.get("/api/recovery/points", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const points = await listRecoveryPoints(recoveryPointListQuerySchema.parse(request.query ?? {}));
    return {
      points: request.user?.role === "viewer"
        ? points.map(redactRecoveryPointForViewer)
        : points.map(sanitizeRecoveryPointForRead)
    };
  });

  app.post("/api/recovery/points", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = recoveryPointCreateSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const { point, job } = await createRecoveryPointWithJob(
      body,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.hostId,
          action: "recovery.point.create",
          targetKind: "recovery_point",
          targetId: queued.recoveryPointId,
          details: {
            appIdentity: queued.appIdentity
          },
          ...auditContext
        }, client);
      }
    );
    return { point: sanitizeRecoveryPointForRead(point), job };
  });

  app.get("/api/recovery/points/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const point = await getRecoveryPoint(id);
    if (!point) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return {
      point: request.user?.role === "viewer"
        ? redactRecoveryPointForViewer(point)
        : sanitizeRecoveryPointForRead(point)
    };
  });

  app.delete("/api/recovery/points/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const point = await deleteRecoveryPoint(id, async (client, deleted) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: deleted.hostId,
        action: "recovery.point.delete",
        targetKind: "recovery_point",
        targetId: id,
        ...auditContext
      }, client);
    });
    if (!point) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return { ok: true };
  });

  app.post("/api/recovery/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const body = recoveryRestoreRequestSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueRecoveryRestore(
      body,
      request.user?.id,
      async (client) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: body.targetHostId,
          action: "recovery.restore",
          targetKind: "recovery_point",
          targetId: body.recoveryPointId,
          details: { targetHostId: body.targetHostId, mode: body.options.mode },
          ...auditContext
        }, client);
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return { job: result.job };
  });

  app.post("/api/recovery/points/:id/verify", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await enqueueRecoveryVerify(
      id,
      request.user?.id,
      async (client, queued) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: queued.point.hostId,
        action: "recovery.verify",
        targetKind: "recovery_point",
        targetId: queued.point.id,
        ...auditContextFromRequest(request)
      }, client);
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return { job: result.job };
  });

  app.post("/api/recovery/points/:id/drill", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueRecoveryDrill(
      id,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.point.hostId,
          action: "recovery.drill",
          targetKind: "recovery_point",
          targetId: id,
          ...auditContext
        }, client);
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return {
      ...result,
      point: sanitizeRecoveryPointForRead(result.point)
    };
  });

  app.get("/api/recovery/schedules", { preHandler: operator, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    schedules: await listRecoverySchedules()
  }));

  app.post("/api/recovery/schedules", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const auditContext = auditContextFromRequest(request);
    const schedule = await createRecoverySchedule(
      request.body,
      request.user?.id,
      async (client, created) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: created.hostId,
          action: "recovery.schedule.create",
          targetKind: "recovery_schedule",
          targetId: created.id,
          ...auditContext
        }, client);
      }
    );
    return { schedule };
  });

  app.delete("/api/recovery/schedules/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const schedule = await deleteRecoverySchedule(id, async (client, deleted) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: deleted.hostId,
        action: "recovery.schedule.delete",
        targetKind: "recovery_schedule",
        targetId: id,
        ...auditContext
      }, client);
    });
    if (!schedule) {
      reply.code(404);
      return { error: "Recovery schedule not found" };
    }
    return { ok: true };
  });

  app.post("/api/recovery/migrations/plan", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = migrationPlanRequestSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const run = await createMigrationPlan(
      body,
      request.user?.id,
      async (client, created) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: body.sourceHostId,
          action: "migration.plan",
          targetKind: "migration_run",
          targetId: created.id,
          details: { targetHostId: body.targetHostId },
          ...auditContext
        }, client);
      }
    );
    return { run };
  });

  app.post("/api/recovery/migrations/execute", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const body = migrationExecuteRequestSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    let result;
    try {
      result = await startMigrationExecute(
        body,
        request.user?.id,
        async (client, queued) => {
          await writeAuditEvent({
            userId: request.user?.id,
            hostId: queued.run.sourceHostId,
            action: "migration.execute",
            targetKind: "migration_run",
            targetId: queued.run.id,
            details: {
              targetHostId: queued.run.targetHostId,
              planRunId: queued.run.planRunId,
              strategy: queued.run.plan?.intent?.strategy ?? null
            },
            ...auditContext
          }, client);
        }
      );
    } catch (error) {
      if (error instanceof MigrationPlanStaleError) {
        return sendApiError(reply, 409, "MIGRATION_PLAN_STALE", error.message, {
          blockingIssues: error.blockingIssues
        });
      }
      throw error;
    }
    return result;
  });

  app.get("/api/recovery/migrations", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const runs = await listMigrationRuns();
    return {
      runs: request.user?.role === "viewer"
        ? runs.map(redactMigrationRunForViewer)
        : runs.map(sanitizeMigrationRunForRead)
    };
  });

  app.get("/api/recovery/migrations/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await getMigrationRun(id);
    if (!run) {
      reply.code(404);
      return { error: "Migration run not found" };
    }
    return {
      run: request.user?.role === "viewer"
        ? redactMigrationRunForViewer(run)
        : sanitizeMigrationRunForRead(run)
    };
  });

  app.get("/api/recovery/targets/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await getBackupTarget(id);
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    return {
      target: request.user?.role === "viewer"
        ? redactBackupTargetForViewer(target)
        : target
    };
  });
}
