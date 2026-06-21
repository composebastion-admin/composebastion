import type { FastifyInstance } from "fastify";
import { configExportSchema, configImportSchema } from "@composebastion/shared";
import { exportConfigBackup, importConfigBackup } from "../services/configBackup.js";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import { configBackupRateLimit } from "../services/rateLimits.js";

export async function registerConfigRoutes(app: FastifyInstance) {
  const admin = requireRole(["owner", "admin"]);

  app.post("/api/config/export", { preHandler: admin, config: { rateLimit: configBackupRateLimit } }, async (request) => {
    const body = configExportSchema.parse(request.body);
    const backup = await exportConfigBackup(body.passphrase);
    await writeAuditEvent({ userId: request.user?.id, action: "config.export", targetKind: "config" });
    return { backup };
  });

  app.post("/api/config/import", { preHandler: admin, config: { rateLimit: configBackupRateLimit } }, async (request) => {
    const body = configImportSchema.parse(request.body);
    const result = await importConfigBackup(body.backup, body.passphrase);
    await writeAuditEvent({ userId: request.user?.id, action: "config.import", targetKind: "config", details: result.imported });
    return result;
  });
}
