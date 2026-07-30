import type { FastifyInstance } from "fastify";
import {
  backupCreateSchema,
  backupDrillSchema,
  backupListQuerySchema,
  backupRestoreSchema,
  backupVerifySchema,
  hostPathBackupCreateSchema,
  hostPathBackupRestoreSchema
} from "@composebastion/shared";
import {
  createBackupWithJob,
  createHostPathBackupWithJob,
  deleteBackup,
  enqueueBackupDrillJob,
  enqueueBackupVerifyJob,
  enqueueHostPathRestoreJob,
  enqueueVolumeRestoreJob,
  getBackup,
  getBackupDownloadStream,
  getBackupHealthSummary,
  listBackups
} from "../services/backups.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { sanitizeBackupForRead } from "../services/mappers.js";
import { downloadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerBackupRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/backups", { preHandler: viewer }, async (request) => {
    const page = await listBackups(backupListQuerySchema.parse(request.query ?? {}));
    return {
      backups: page.items.map(sanitizeBackupForRead),
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
    const auditContext = auditContextFromRequest(request);
    const { backup, job } = await createBackupWithJob(body.hostId, body.volumeName, {
      backupTargetId: body.backupTargetId,
      encryption: body.encryption
    }, request.user?.id, async (client, created) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: body.hostId,
        action: "volume.backup",
        targetKind: "backup",
        targetId: created.backup.id,
        details: { volumeName: body.volumeName, backupTargetId: body.backupTargetId ?? null, encryption: body.encryption },
        ...auditContext
      }, client);
    });
    return { backup: sanitizeBackupForRead(backup), job };
  });

  app.post("/api/backups/host-path", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = hostPathBackupCreateSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const { backup, job } = await createHostPathBackupWithJob(body.hostId, body.sourcePath, {
      backupTargetId: body.backupTargetId,
      encryption: body.encryption
    }, request.user?.id, async (client, created) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: body.hostId,
        action: "hostPath.backup",
        targetKind: "backup",
        targetId: created.backup.id,
        details: { sourcePath: created.backup.sourcePath, backupTargetId: body.backupTargetId ?? null, encryption: body.encryption },
        ...auditContext
      }, client);
    });
    return { backup: sanitizeBackupForRead(backup), job };
  });

  app.get("/api/backups/:id", { preHandler: viewer }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = await getBackup(id);
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { backup: sanitizeBackupForRead(backup) };
  });

  app.post("/api/backups/:id/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = backupRestoreSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueVolumeRestoreJob({
      backupId: id,
      targetHostId: body.targetHostId,
      targetVolumeName: body.targetVolumeName,
      overwrite: body.overwrite
    }, request.user?.id, async (client) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: body.targetHostId,
        action: "volume.restore",
        targetKind: "backup",
        targetId: id,
        details: { targetVolumeName: body.targetVolumeName, overwrite: body.overwrite },
        ...auditContext
      }, client);
    });
    if (!result) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { job: result.job };
  });

  app.post("/api/backups/:id/restore-host-path", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = hostPathBackupRestoreSchema.parse(request.body);
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueHostPathRestoreJob({
      backupId: id,
      targetHostId: body.targetHostId,
      targetPath: body.targetPath,
      overwrite: body.overwrite
    }, request.user?.id, async (client) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: body.targetHostId,
        action: "hostPath.restore",
        targetKind: "backup",
        targetId: id,
        details: { targetPath: body.targetPath, overwrite: body.overwrite },
        ...auditContext
      }, client);
    });
    if (!result) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { job: result.job };
  });

  app.post("/api/backups/:id/verify", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = backupVerifySchema.parse(request.body ?? {});
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueBackupVerifyJob(
      id,
      body.testArchive,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.backup.hostId,
          action: "backup.verify",
          targetKind: "backup",
          targetId: id,
          details: { testArchive: body.testArchive },
          ...auditContext
        }, client);
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { job: result.job };
  });

  app.post("/api/backups/:id/drill", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    backupDrillSchema.parse(request.body ?? {});
    const auditContext = auditContextFromRequest(request);
    const result = await enqueueBackupDrillJob(
      id,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.backup.hostId,
          action: "backup.drill",
          targetKind: "backup",
          targetId: id,
          details: {
            kind: queued.backup.kind,
            label: queued.backup.kind === "host_path"
              ? queued.backup.sourcePath
              : queued.backup.volumeName
          },
          ...auditContext
        }, client);
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { job: result.job };
  });

  const downloadHandler = async (request: any, reply: any) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const download = await getBackupDownloadStream(
      id,
      async (client, backup) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: backup.hostId,
          action: "backup.download",
          targetKind: "backup",
          targetId: id,
          details: {
            kind: backup.kind,
            label: backup.kind === "host_path"
              ? backup.sourcePath
              : backup.volumeName
          },
          ...auditContext
        }, client);
      }
    );
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
    const auditContext = auditContextFromRequest(request);
    const backup = await deleteBackup(id, async (client, deleted) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: deleted.hostId,
        action: "backup.delete",
        targetKind: "backup",
        targetId: id,
        details: {
          kind: deleted.kind,
          label: deleted.kind === "host_path"
            ? deleted.sourcePath
            : deleted.volumeName
        },
        ...auditContext
      }, client);
    });
    if (!backup) {
      reply.code(404);
      return { error: "Backup not found" };
    }
    return { ok: true };
  });
}
