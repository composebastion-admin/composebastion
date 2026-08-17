import type { FastifyInstance } from "fastify";
import { requireRole } from "../services/auth.js";
import { createBackupSchedule, deleteBackupSchedule, listBackupSchedules } from "../services/backupSchedules.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerBackupScheduleRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/backup-schedules", { preHandler: operator, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    schedules: await listBackupSchedules()
  }));

  app.post("/api/backup-schedules", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const auditContext = auditContextFromRequest(request);
    const schedule = await createBackupSchedule(
      request.body,
      request.user?.id,
      async (client, created) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: created.hostId,
          action: "backup.schedule.create",
          targetKind: "backup_schedule",
          targetId: created.id,
          details: {
            kind: created.kind,
            volumeName: created.volumeName,
            sourcePath: created.sourcePath,
            encryption: created.encryption
          },
          ...auditContext
        }, client);
      }
    );
    return { schedule };
  });

  app.delete("/api/backup-schedules/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auditContext = auditContextFromRequest(request);
    const schedule = await deleteBackupSchedule(id, async (client, deleted) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: deleted.hostId,
        action: "backup.schedule.delete",
        targetKind: "backup_schedule",
        targetId: id,
        details: {
          kind: deleted.kind,
          volumeName: deleted.volumeName,
          sourcePath: deleted.sourcePath
        },
        ...auditContext
      }, client);
    });
    if (!schedule) {
      reply.code(404);
      return { error: "Backup schedule not found" };
    }
    return { ok: true };
  });
}
