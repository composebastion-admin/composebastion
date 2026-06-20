import type { FastifyInstance } from "fastify";
import {
  backupCreateSchema,
  backupDrillSchema,
  backupListQuerySchema,
  backupRestoreSchema,
  backupVerifySchema,
  hostPathBackupCreateSchema,
  hostPathBackupRestoreSchema
} from "@dockermender/shared";
import {
  createBackupRecord,
  createHostPathBackupRecord,
  deleteBackup,
  getBackup,
  getBackupDownloadStream,
  getBackupHealthSummary,
  listBackups
} from "../services/backups.js";
import { requireRole } from "../services/auth.js";
import { enqueueJob } from "../services/jobs.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { downloadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerBackupRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/backups", { preHandler: viewer }, async (request) => {
    const page = await listBackups(backupListQuerySchema.parse(request.query ?? {}));
    return {
      backups: page.items,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore
    };
  });

  app.get("/api/backups/health", { preHandler: viewer }, async () => ({
    health: await getBackupHealthSummary()
  }));

  app.post("/api/backups", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = backupCreateSchema.parse(request.body);
    const backup = await createBackupRecord(body.hostId, body.volumeName, {
      backupTargetId: body.backupTargetId,
      encryption: body.encryption
    });
    const job = await enqueueJob(
      { type: "volume.backup", hostId: body.hostId, payload: { backupId: backup.id, volumeName: body.volumeName } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "volume.backup",
      targetKind: "backup",
      targetId: backup.id,
      details: { volumeName: body.volumeName, backupTargetId: body.backupTargetId ?? null, encryption: body.encryption },
      ...auditContextFromRequest(request)
    });
    return { backup, job };
  });

  app.post("/api/backups/host-path", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = hostPathBackupCreateSchema.parse(request.body);
    const backup = await createHostPathBackupRecord(body.hostId, body.sourcePath, {
      backupTargetId: body.backupTargetId,
      encryption: body.encryption
    });
    const job = await enqueueJob(
      { type: "hostPath.backup", hostId: body.hostId, payload: { backupId: backup.id, sourcePath: backup.sourcePath ?? body.sourcePath } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "hostPath.backup",
      targetKind: "backup",
      targetId: backup.id,
      details: { sourcePath: backup.sourcePath, backupTargetId: body.backupTargetId ?? null, encryption: body.encryption },
      ...auditContextFromRequest(request)
    });
    return { backup, job };
  });

  app.get("/api/backups/:id", { preHandler: viewer }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { backup };
  });

  app.post("/api/backups/:id/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    if (backup.kind !== "volume") {
      reply.code(400);
      return { error: "Use the host-path restore endpoint for host-path backups" };
    }
    const body = backupRestoreSchema.parse(request.body);
    const job = await enqueueJob(
      { type: "volume.restore", hostId: body.targetHostId, payload: { backupId: id, targetVolumeName: body.targetVolumeName, overwrite: body.overwrite } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.targetHostId,
      action: "volume.restore",
      targetKind: "backup",
      targetId: id,
      details: { targetVolumeName: body.targetVolumeName, overwrite: body.overwrite },
      ...auditContextFromRequest(request)
    });
    return { job };
  });

  app.post("/api/backups/:id/restore-host-path", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    if (backup.kind !== "host_path") {
      reply.code(400);
      return { error: "Use the volume restore endpoint for volume backups" };
    }
    const body = hostPathBackupRestoreSchema.parse(request.body);
    const job = await enqueueJob(
      { type: "hostPath.restore", hostId: body.targetHostId, payload: { backupId: id, targetPath: body.targetPath, overwrite: body.overwrite } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.targetHostId,
      action: "hostPath.restore",
      targetKind: "backup",
      targetId: id,
      details: { targetPath: body.targetPath, overwrite: body.overwrite },
      ...auditContextFromRequest(request)
    });
    return { job };
  });

  app.post("/api/backups/:id/verify", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    const body = backupVerifySchema.parse(request.body ?? {});
    const job = await enqueueJob(
      { type: "backup.verify", hostId: backup.hostId, payload: { backupId: id, testArchive: body.testArchive } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: backup.hostId,
      action: "backup.verify",
      targetKind: "backup",
      targetId: id,
      details: { testArchive: body.testArchive },
      ...auditContextFromRequest(request)
    });
    return { job };
  });

  app.post("/api/backups/:id/drill", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    backupDrillSchema.parse(request.body ?? {});
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    const job = await enqueueJob(
      { type: "backup.drill", hostId: backup.hostId, payload: { backupId: id } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: backup.hostId,
      action: "backup.drill",
      targetKind: "backup",
      targetId: id,
      details: { kind: backup.kind, label: backup.kind === "host_path" ? backup.sourcePath : backup.volumeName },
      ...auditContextFromRequest(request)
    });
    return { job };
  });

  const downloadHandler = async (request: any, reply: any) => {
    const { id } = request.params as { id: string };
    const download = await getBackupDownloadStream(id);
    if (!download) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${download.backup.fileName}"`);
    return reply.send(download.stream);
  };
  app.get("/api/backups/:id/download", { preHandler: operator, config: { rateLimit: downloadRateLimit } }, downloadHandler);
  app.get("/api/v1/backups/:id/download", { preHandler: operator, config: { rateLimit: downloadRateLimit } }, downloadHandler);

  app.delete("/api/backups/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await deleteBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: backup.hostId,
      action: "backup.delete",
      targetKind: "backup",
      targetId: id,
      details: { kind: backup.kind, label: backup.kind === "host_path" ? backup.sourcePath : backup.volumeName },
      ...auditContextFromRequest(request)
    });
    return { ok: true };
  });
}
