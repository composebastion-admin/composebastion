import type { FastifyInstance } from "fastify";
import {
  sanitizePlaintextHttpSourceUrl,
  sanitizeUrlDiagnosticText,
  selfUpdateConfigInputSchema,
  selfUpdateStartSchema
} from "@composebastion/shared";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { sendApiError } from "../services/apiError.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";
import { sanitizeOperationJobForRead } from "../services/mappers.js";
import { checkSelfUpdateLatest, enqueueSelfUpdate, getSelfUpdateStatus, saveSelfUpdateConfig } from "../services/selfUpdate.js";

function sanitizeSelfUpdateStatusForRead(
  status: Awaited<ReturnType<typeof getSelfUpdateStatus>>
) {
  const sanitizedHtmlUrl = "htmlUrl" in status.latest
    ? { htmlUrl: sanitizePlaintextHttpSourceUrl(status.latest.htmlUrl) }
    : {};
  return {
    ...status,
    latest: {
      ...status.latest,
      ...sanitizedHtmlUrl,
      error: sanitizeUrlDiagnosticText(status.latest.error) as string | null
    },
    lastJob: status.lastJob ? sanitizeOperationJobForRead(status.lastJob) : null
  };
}

export async function registerSelfUpdateRoutes(app: FastifyInstance) {
  const admin = requireRole(["owner", "admin"]);

  app.get("/api/self-update", { preHandler: admin, config: { rateLimit: authenticatedReadRateLimit } }, async () => (
    sanitizeSelfUpdateStatusForRead(await getSelfUpdateStatus())
  ));

  app.put("/api/self-update/config", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    try {
      const config = await saveSelfUpdateConfig(
        selfUpdateConfigInputSchema.parse(request.body),
        async (client, saved) => {
          await writeAuditEvent({
            userId: request.user?.id,
            hostId: saved.hostId,
            action: "system.self_update.config",
            targetKind: "system_setting",
            targetId: "self_update.config",
            ...auditContextFromRequest(request)
          }, client);
        }
      );
      return { config };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 404) {
        return sendApiError(reply, 404, "NOT_FOUND", error instanceof Error ? error.message : "Manager host not found");
      }
      throw error;
    }
  });

  app.post("/api/self-update/check", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const latest = await checkSelfUpdateLatest(async (client, checked) => {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "system.self_update.check",
        targetKind: "system_setting",
        targetId: "self_update.latest",
        details: {
          version: checked.version,
          succeeded: checked.error === null
        },
        ...auditContextFromRequest(request)
      }, client);
    });
    const status = await getSelfUpdateStatus();
    return sanitizeSelfUpdateStatusForRead({ ...status, latest });
  });

  app.post("/api/self-update/start", { preHandler: admin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = selfUpdateStartSchema.parse(request.body);
    const job = await enqueueSelfUpdate(
      body,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.hostId,
          action: "system.self_update.start",
          targetKind: "operation_job",
          targetId: queued.id,
          details: { targetVersion: body.targetVersion ?? null },
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return { job: sanitizeOperationJobForRead(job) };
  });
}
