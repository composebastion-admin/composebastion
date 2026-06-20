import type { FastifyInstance } from "fastify";
import { requireRole } from "../services/auth.js";
import { createBackupSchedule, deleteBackupSchedule, listBackupSchedules } from "../services/backupSchedules.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerBackupScheduleRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/backup-schedules", { preHandler: operator }, async () => ({
    schedules: await listBackupSchedules()
  }));

  app.post("/api/backup-schedules", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const schedule = await createBackupSchedule(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: schedule.hostId,
      action: "backup.schedule.create",
      targetKind: "backup_schedule",
      targetId: schedule.id,
      details: { kind: schedule.kind, volumeName: schedule.volumeName, sourcePath: schedule.sourcePath, encryption: schedule.encryption },
      ...auditContextFromRequest(request)
    });
    return { schedule };
  });

  app.delete("/api/backup-schedules/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const schedule = await deleteBackupSchedule(id);
    if (!schedule) {
      reply.code(404);
      return { error: "Backup schedule not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: schedule.hostId,
      action: "backup.schedule.delete",
      targetKind: "backup_schedule",
      targetId: id,
      details: { kind: schedule.kind, volumeName: schedule.volumeName, sourcePath: schedule.sourcePath },
      ...auditContextFromRequest(request)
    });
    return { ok: true };
  });
}
