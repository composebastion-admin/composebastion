import type { FastifyInstance } from "fastify";
import { idSchema } from "@composebastion/shared";
import { cancelQueuedJob, getJob, getWorkerStatus, listJobs, retryJob } from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { sendApiError } from "../services/apiError.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";
import { redactJobSensitiveFields, sanitizeOperationJobForRead } from "../services/mappers.js";

const nonIdempotentWorkerLossTypes = new Set([
  "host.configureRegistryTrust",
  "deploy.execute"
]);

export async function registerJobRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/jobs", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    const page = await listJobs(request.query);
    const sanitized = page.items.map(sanitizeOperationJobForRead);
    const items = request.user?.role === "viewer"
      ? sanitized.map(redactJobSensitiveFields)
      : sanitized;
    return { jobs: items, ...page, items };
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
    return {
      job: request.user?.role === "viewer"
        ? redactJobSensitiveFields(sanitizeOperationJobForRead(job))
        : sanitizeOperationJobForRead(job)
    };
  });

  app.post("/api/jobs/:id/cancel", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const result = await cancelQueuedJob(id, async (client, canceled) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: canceled.job.hostId,
        action: "job.cancel",
        targetKind: "operation_job",
        targetId: canceled.job.id,
        details: { type: canceled.job.type },
        ...auditContextFromRequest(request)
      }, client);
    });
    if (!result.job) return sendApiError(reply, 404, "NOT_FOUND", "Job not found");
    if (!result.canceled) return sendApiError(reply, 409, "CONFLICT", "Only queued jobs can be canceled");
    return { job: sanitizeOperationJobForRead(result.job) };
  });

  app.post("/api/jobs/:id/retry", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const result = await retryJob(id, request.user?.id, async (client, retried) => {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: retried.original.hostId,
        action: "job.retry",
        targetKind: "operation_job",
        targetId: retried.original.id,
        details: {
          retriedJobId: retried.retried.id,
          type: retried.original.type
        },
        ...auditContextFromRequest(request)
      }, client);
    });
    if (!result.original) return sendApiError(reply, 404, "NOT_FOUND", "Job not found");
    if (!result.retried) {
      const ambiguousWorkerLoss = nonIdempotentWorkerLossTypes.has(result.original.type)
        && result.original.error?.startsWith("WORKER_LOST");
      return sendApiError(
        reply,
        409,
        "CONFLICT",
        ambiguousWorkerLoss
          ? "The worker lease expired during a non-idempotent operation. Reconcile the deployment or registry state before starting a new operation; automatic replay is disabled."
          : "This job is not eligible for retry because its status, operation type, host assignment, or attempt limit does not permit replay."
      );
    }
    return {
      job: sanitizeOperationJobForRead(result.retried),
      original: sanitizeOperationJobForRead(result.original)
    };
  });
}
