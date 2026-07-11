import type { FastifyInstance } from "fastify";
import { dockerActionSchema, resourceKindSchema } from "@composebastion/shared";
import { createHostWithSync, deleteHost, getHost, listHosts, restoreHost, updateHost } from "../services/hosts.js";
import { auditContextFromRequest } from "../services/audit.js";
import { sendApiError } from "../services/apiError.js";
import { listImageCleanupCandidates, listResources } from "../services/docker.js";
import { enqueueJob } from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerHostRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/hosts", { preHandler: viewer }, async () => ({
    hosts: await listHosts()
  }));

  app.post("/api/hosts", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    try {
      const { host, job } = await createHostWithSync(request.body, request.user?.id);
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: host.id,
        action: "host.create",
        targetKind: "host",
        targetId: host.id,
        ...auditContextFromRequest(request)
      });
      return { host, job };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 409) {
        return sendApiError(reply, 409, "CONFLICT", error instanceof Error ? error.message : "Conflict");
      }
      throw error;
    }
  });

  app.get("/api/hosts/:id", { preHandler: viewer }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const host = await getHost(id);
    if (!host) {
      reply.code(404);
      return { error: "Host not found" };
    }
    return { host };
  });

  app.put("/api/hosts/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const host = await updateHost(id, request.body);
    if (!host) {
      reply.code(404);
      return { error: "Host not found" };
    }
    await writeAuditEvent({ userId: request.user?.id, hostId: id, action: "host.update", targetKind: "host", targetId: id });
    return { host };
  });

  app.delete("/api/hosts/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const host = await getHost(id);
    if (!host) {
      return sendApiError(reply, 404, "NOT_FOUND", "Host not found");
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: id,
      action: "host.delete",
      targetKind: "host",
      targetId: id,
      ...auditContextFromRequest(request)
    });
    await deleteHost(id);
    return { ok: true };
  });

  app.post("/api/hosts/:id/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const host = await restoreHost(id);
    if (!host) {
      return sendApiError(reply, 404, "NOT_FOUND", "Host not found or not deleted");
    }
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: id,
      action: "host.restore",
      targetKind: "host",
      targetId: id,
      ...auditContextFromRequest(request)
    });
    return { host };
  });

  app.post("/api/hosts/:id/check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await enqueueJob({ type: "host.check", hostId: id, payload: {} }, request.user?.id);
    return { job };
  });

  app.post("/api/hosts/:id/sync", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await enqueueJob({ type: "host.sync", hostId: id, payload: {} }, request.user?.id);
    return { job };
  });

  app.get("/api/hosts/:id/resources", { preHandler: viewer }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { kind?: string };
    const kind = query.kind ? resourceKindSchema.parse(query.kind) : undefined;
    return { resources: await listResources(id, kind) };
  });

  app.get("/api/hosts/:id/image-cleanup", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    return { candidates: await listImageCleanupCandidates(id) };
  });

  app.post("/api/hosts/:id/actions", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const incoming = request.body as Record<string, unknown>;
    const action = dockerActionSchema.parse({ ...incoming, hostId: id });
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"]
      : undefined;
    const job = await enqueueJob(action, request.user?.id, idempotencyKey);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: id,
      action: action.type,
      targetKind: "job",
      targetId: job.id,
      ...auditContextFromRequest(request)
    });
    return { job };
  });
}
