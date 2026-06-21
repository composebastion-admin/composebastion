import type { FastifyInstance } from "fastify";
import { idSchema } from "@composebastion/shared";
import { cancelQueuedJob, getJob, getWorkerStatus, listJobs, retryJob } from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { sendApiError } from "../services/apiError.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerJobRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/jobs", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const page = await listJobs(request.query);
    return { jobs: page.items, ...page };
  });

  app.get("/api/jobs/status", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    worker: await getWorkerStatus()
  }));

  app.get("/api/jobs/:id", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const job = await getJob(id);
    if (!job) {
      return sendApiError(reply, 404, "NOT_FOUND", "Job not found");
    }
    return { job };
  });

  app.post("/api/jobs/:id/cancel", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const result = await cancelQueuedJob(id);
    if (!result.job) return sendApiError(reply, 404, "NOT_FOUND", "Job not found");
    if (!result.canceled) return sendApiError(reply, 409, "CONFLICT", "Only queued jobs can be canceled");
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.job.hostId,
      action: "job.cancel",
      targetKind: "operation_job",
      targetId: result.job.id,
      details: { type: result.job.type },
      ...auditContextFromRequest(request)
    });
    return { job: result.job };
  });

  app.post("/api/jobs/:id/retry", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const result = await retryJob(id, request.user?.id);
    if (!result.original) return sendApiError(reply, 404, "NOT_FOUND", "Job not found");
    if (!result.retried) return sendApiError(reply, 409, "CONFLICT", "Only failed or canceled jobs can be retried");
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.original.hostId,
      action: "job.retry",
      targetKind: "operation_job",
      targetId: result.original.id,
      details: { retriedJobId: result.retried.id, type: result.original.type },
      ...auditContextFromRequest(request)
    });
    return { job: result.retried, original: result.original };
  });
}
