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
  recoveryRestoreRequestSchema
} from "@composebastion/shared";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import {
  createBackupTarget,
  createMigrationPlan,
  createRecoveryPoint,
  createRecoverySchedule,
  deleteBackupTarget,
  deleteRecoveryPoint,
  deleteRecoverySchedule,
  enqueueRecoveryDrill,
  enqueueRecoveryCreate,
  enqueueRecoveryRestore,
  enqueueRecoveryVerify,
  getBackupTarget,
  getMigrationRun,
  getRecoveryPoint,
  listBackupTargets,
  listMigrationRuns,
  listRecoveryPoints,
  listRecoverySchedules,
  startMigrationExecute,
  testBackupTarget,
  updateBackupTarget
} from "../services/recoveryCenter.js";
import { analyzeRecovery } from "../services/recoveryAnalysis.js";
import { deleteRecoveryProfile, getRecoveryProfile, getRecoveryProfileForApp, upsertRecoveryProfile } from "../services/recoveryProfiles.js";
import { analyzeRecoveryReadiness, listRecoveryReadiness } from "../services/recoveryReadiness.js";
import { authenticatedReadRateLimit, expensiveReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerRecoveryCenterRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/recovery/targets", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    targets: await listBackupTargets()
  }));

  app.post("/api/recovery/targets", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const target = await createBackupTarget(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "recovery.target.create",
      targetKind: "backup_target",
      targetId: target.id
    });
    return { target };
  });

  app.patch("/api/recovery/targets/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await updateBackupTarget(id, backupTargetUpdateSchema.parse(request.body));
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      action: "recovery.target.update",
      targetKind: "backup_target",
      targetId: target.id
    });
    return { target };
  });

  app.delete("/api/recovery/targets/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await deleteBackupTarget(id);
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      action: "recovery.target.delete",
      targetKind: "backup_target",
      targetId: id
    });
    return { ok: true };
  });

  app.post("/api/recovery/targets/:id/test", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await getBackupTarget(id);
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    const result = await testBackupTarget(id);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "recovery.target.test",
      targetKind: "backup_target",
      targetId: id,
      details: { ok: result.ok }
    });
    if (!result.ok) reply.code(400);
    return result;
  });

  app.post("/api/recovery/analyze", { preHandler: viewer, config: { rateLimit: expensiveReadRateLimit } }, async (request) => {
    const body = recoveryAnalysisRequestSchema.parse(request.body);
    return { analysis: await analyzeRecovery(body) };
  });

  app.get("/api/recovery/readiness", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const query = recoveryReadinessListQuerySchema.parse(request.query ?? {});
    return { readiness: await listRecoveryReadiness(query.hostId) };
  });

  app.post("/api/recovery/readiness/analyze", { preHandler: viewer, config: { rateLimit: expensiveReadRateLimit } }, async (request) => {
    const body = recoveryReadinessAnalyzeRequestSchema.parse(request.body);
    return { readiness: await analyzeRecoveryReadiness(body) };
  });

  app.post("/api/recovery/profiles/lookup", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const body = recoveryProfileInputSchema.pick({ hostId: true, appIdentity: true }).parse(request.body);
    return { profile: await getRecoveryProfileForApp(body.hostId, body.appIdentity) };
  });

  app.put("/api/recovery/profiles", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const profile = await upsertRecoveryProfile(recoveryProfileInputSchema.parse(request.body), request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: profile.hostId,
      action: "recovery.profile.upsert",
      targetKind: "recovery_profile",
      targetId: profile.id
    });
    return { profile };
  });

  app.get("/api/recovery/profiles/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await getRecoveryProfile(id);
    if (!profile) {
      reply.code(404);
      return { error: "Recovery profile not found" };
    }
    return { profile };
  });

  app.delete("/api/recovery/profiles/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await deleteRecoveryProfile(id);
    if (!profile) {
      reply.code(404);
      return { error: "Recovery profile not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: profile.hostId,
      action: "recovery.profile.delete",
      targetKind: "recovery_profile",
      targetId: id
    });
    return { ok: true };
  });

  app.get("/api/recovery/points", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => ({
    points: await listRecoveryPoints(recoveryPointListQuerySchema.parse(request.query ?? {}))
  }));

  app.post("/api/recovery/points", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = recoveryPointCreateSchema.parse(request.body);
    const point = await createRecoveryPoint(body, request.user?.id);
    const job = await enqueueRecoveryCreate(point.id, point.hostId, request.user?.id, Boolean(point.metadata.stopFirst));
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: point.hostId,
      action: "recovery.point.create",
      targetKind: "recovery_point",
      targetId: point.id,
      details: { appIdentity: point.appIdentity }
    });
    return { point, job };
  });

  app.get("/api/recovery/points/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const point = await getRecoveryPoint(id);
    if (!point) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    return { point };
  });

  app.delete("/api/recovery/points/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const point = await deleteRecoveryPoint(id);
    if (!point) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: point.hostId,
      action: "recovery.point.delete",
      targetKind: "recovery_point",
      targetId: id
    });
    return { ok: true };
  });

  app.post("/api/recovery/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = recoveryRestoreRequestSchema.parse(request.body);
    const point = await getRecoveryPoint(body.recoveryPointId);
    if (!point) throw new Error("Recovery point not found");
    const job = await enqueueRecoveryRestore(body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.targetHostId,
      action: "recovery.restore",
      targetKind: "recovery_point",
      targetId: body.recoveryPointId,
      details: { targetHostId: body.targetHostId, mode: body.options.mode }
    });
    return { job };
  });

  app.post("/api/recovery/points/:id/verify", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const point = await getRecoveryPoint(id);
    if (!point) throw new Error("Recovery point not found");
    const job = await enqueueRecoveryVerify(point.id, point.hostId, request.user?.id);
    return { job };
  });

  app.post("/api/recovery/points/:id/drill", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await enqueueRecoveryDrill(id, request.user?.id);
    if (!result) {
      reply.code(404);
      return { error: "Recovery point not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.point.hostId,
      action: "recovery.drill",
      targetKind: "recovery_point",
      targetId: id
    });
    return result;
  });

  app.get("/api/recovery/schedules", { preHandler: operator, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    schedules: await listRecoverySchedules()
  }));

  app.post("/api/recovery/schedules", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const schedule = await createRecoverySchedule(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: schedule.hostId,
      action: "recovery.schedule.create",
      targetKind: "recovery_schedule",
      targetId: schedule.id
    });
    return { schedule };
  });

  app.delete("/api/recovery/schedules/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteRecoverySchedule(id);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "recovery.schedule.delete",
      targetKind: "recovery_schedule",
      targetId: id
    });
    return { ok: true };
  });

  app.post("/api/recovery/migrations/plan", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = migrationPlanRequestSchema.parse(request.body);
    const run = await createMigrationPlan(body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.sourceHostId,
      action: "migration.plan",
      targetKind: "migration_run",
      targetId: run.id,
      details: { targetHostId: body.targetHostId }
    });
    return { run };
  });

  app.post("/api/recovery/migrations/execute", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = migrationExecuteRequestSchema.parse(request.body);
    const result = await startMigrationExecute(body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.sourceHostId,
      action: "migration.execute",
      targetKind: "migration_run",
      targetId: result.run.id,
      details: { targetHostId: body.targetHostId, strategy: body.strategy }
    });
    return result;
  });

  app.get("/api/recovery/migrations", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    runs: await listMigrationRuns()
  }));

  app.get("/api/recovery/migrations/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await getMigrationRun(id);
    if (!run) {
      reply.code(404);
      return { error: "Migration run not found" };
    }
    return { run };
  });

  app.get("/api/recovery/targets/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const target = await getBackupTarget(id);
    if (!target) {
      reply.code(404);
      return { error: "Backup target not found" };
    }
    return { target };
  });
}
