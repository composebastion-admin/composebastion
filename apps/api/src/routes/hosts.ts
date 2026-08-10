import type { FastifyInstance } from "fastify";
import {
  directHostActionTypeSchema,
  dockerActionSchema,
  resourceKindSchema
} from "@composebastion/shared";
import { createHostWithSync, deleteHost, getHost, listHosts, restoreHost, updateHost } from "../services/hosts.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { sendApiError } from "../services/apiError.js";
import { listImageCleanupCandidates, listResources } from "../services/docker.js";
import {
  enqueueJobInTransaction,
  notifyJobQueued
} from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";
import { sanitizeOperationJobForRead } from "../services/mappers.js";
import { withTransaction } from "../db/pool.js";

export async function registerHostRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/hosts", { preHandler: viewer }, async () => ({
    hosts: await listHosts()
  }));

  app.post("/api/hosts", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    try {
      const { host, job } = await createHostWithSync(
        request.body,
        request.user?.id,
        {
          userId: request.user?.id,
          ...auditContextFromRequest(request)
        }
      );
      return { host, job: sanitizeOperationJobForRead(job) };
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
    let host: Awaited<ReturnType<typeof updateHost>>;
    try {
      host = await updateHost(id, request.body, {
        userId: request.user?.id,
        ...auditContextFromRequest(request)
      });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 409) {
        return sendApiError(
          reply,
          409,
          "CONFLICT",
          error instanceof Error ? error.message : "Conflict"
        );
      }
      throw error;
    }
    if (!host) {
      reply.code(404);
      return { error: "Host not found" };
    }
    return { host };
  });

  app.delete("/api/hosts/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const deleted = await deleteHost(id, {
        userId: request.user?.id,
        ...auditContextFromRequest(request)
      });
      if (!deleted) {
        return sendApiError(reply, 404, "NOT_FOUND", "Host not found");
      }
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 409) {
        return sendApiError(
          reply,
          409,
          "CONFLICT",
          error instanceof Error ? error.message : "Conflict"
        );
      }
      throw error;
    }
    return { ok: true };
  });

  app.post("/api/hosts/:id/restore", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    let host: Awaited<ReturnType<typeof restoreHost>>;
    try {
      host = await restoreHost(id, {
        userId: request.user?.id,
        ...auditContextFromRequest(request)
      });
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 409) {
        return sendApiError(reply, 409, "CONFLICT", error instanceof Error ? error.message : "Conflict");
      }
      throw error;
    }
    if (!host) {
      return sendApiError(reply, 404, "NOT_FOUND", "Host not found or not deleted");
    }
    return { host };
  });

  app.post("/api/hosts/:id/check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await withTransaction(async (client) => {
      const queued = await enqueueJobInTransaction(
        client,
        { type: "host.check", hostId: id, payload: {} },
        request.user?.id
      );
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: id,
        action: "host.check",
        targetKind: "job",
        targetId: queued.id,
        ...auditContextFromRequest(request)
      }, client);
      return queued;
    });
    await notifyJobQueued(job.id);
    return { job: sanitizeOperationJobForRead(job) };
  });

  app.post("/api/hosts/:id/sync", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await withTransaction(async (client) => {
      const queued = await enqueueJobInTransaction(
        client,
        { type: "host.sync", hostId: id, payload: {} },
        request.user?.id
      );
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: id,
        action: "host.sync",
        targetKind: "job",
        targetId: queued.id,
        ...auditContextFromRequest(request)
      }, client);
      return queued;
    });
    await notifyJobQueued(job.id);
    return { job: sanitizeOperationJobForRead(job) };
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

  app.post("/api/hosts/:id/actions", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const incoming = request.body;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return sendApiError(
        reply,
        400,
        "VALIDATION_FAILED",
        "Request body must be a JSON object."
      );
    }
    const incomingAction = incoming as Record<string, unknown>;
    // Jobs that depend on a durable domain record, reviewed plan, state
    // transition, credential lookup, or dedicated audit contract must enter
    // through that feature's route.
    const directActionType = directHostActionTypeSchema.safeParse(incomingAction.type);
    if (!directActionType.success) {
      return sendApiError(
        reply,
        400,
        "VALIDATION_FAILED",
        typeof incomingAction.type === "string"
          ? "This orchestrated action can only be started through its dedicated API endpoint."
          : "Request body must include a supported direct action type."
      );
    }
    const action = dockerActionSchema.parse({ ...incomingAction, hostId: id });
    const idempotencyKey = typeof request.headers["idempotency-key"] === "string"
      ? request.headers["idempotency-key"]
      : undefined;
    const job = await withTransaction(async (client) => {
      const queued = await enqueueJobInTransaction(
        client,
        action,
        request.user?.id,
        idempotencyKey
      );
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: id,
        action: directActionType.data,
        targetKind: "job",
        targetId: queued.id,
        ...auditContextFromRequest(request)
      }, client);
      return queued;
    });
    await notifyJobQueued(job.id);
    return { job: sanitizeOperationJobForRead(job) };
  });
}
