import type { FastifyInstance } from "fastify";
import { selfUpdateConfigInputSchema, selfUpdateStartSchema } from "@composebastion/shared";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { sendApiError } from "../services/apiError.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";
import { checkSelfUpdateLatest, enqueueSelfUpdate, getSelfUpdateStatus, saveSelfUpdateConfig } from "../services/selfUpdate.js";

export async function registerSelfUpdateRoutes(app: FastifyInstance) {
  const admin = requireRole(["owner", "admin"]);

  app.get("/api/self-update", { preHandler: admin, config: { rateLimit: authenticatedReadRateLimit } }, async () => (
    await getSelfUpdateStatus()
  ));

  app.put("/api/self-update/config", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    try {
      const config = await saveSelfUpdateConfig(selfUpdateConfigInputSchema.parse(request.body));
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: config.hostId,
        action: "system.self_update.config",
        targetKind: "system_setting",
        targetId: "self_update.config",
        ...auditContextFromRequest(request)
      });
      return { config };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 404) {
        return sendApiError(reply, 404, "NOT_FOUND", error instanceof Error ? error.message : "Manager host not found");
      }
      throw error;
    }
  });

  app.post("/api/self-update/check", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async () => {
    const latest = await checkSelfUpdateLatest();
    const status = await getSelfUpdateStatus();
    return { ...status, latest };
  });

  app.post("/api/self-update/start", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = selfUpdateStartSchema.parse(request.body);
    const job = await enqueueSelfUpdate(body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: job.hostId,
      action: "system.self_update.start",
      targetKind: "operation_job",
      targetId: job.id,
      details: { targetVersion: body.targetVersion ?? null },
      ...auditContextFromRequest(request)
    });
    return { job };
  });
}
