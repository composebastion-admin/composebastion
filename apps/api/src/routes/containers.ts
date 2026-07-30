import type { FastifyInstance } from "fastify";
import { containerCloneSchema, containerExecRequestSchema, volumeCloneSchema } from "@composebastion/shared";
import { z } from "zod";
import { createVolumeBackupsWithJobs, createVolumeCloneWithJob } from "../services/backups.js";
import { execInContainer, getContainerInspect, getContainerLogs, getContainerStats, getContainerUsage, getContainerVolumeMounts, redactInspectEnv, streamContainerLogs, streamContainerUsage } from "../services/docker.js";
import { enqueueJobInTransaction, notifyJobQueued } from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { withTransaction } from "../db/pool.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit, streamRateLimit } from "../services/rateLimits.js";

const containerParamSchema = z.object({
  hostId: z.string().uuid(),
  containerId: z.string().min(1)
});

const containerTailQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(5000).default(500)
});

const inspectEnvRoles = new Set(["owner", "admin", "operator"]);

export async function registerContainerRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/hosts/:hostId/containers/:containerId/logs", { preHandler: viewer }, async (request) => {
    const { hostId, containerId } = containerParamSchema.parse(request.params);
    const { tail } = containerTailQuerySchema.partial().parse(request.query);
    return getContainerLogs(hostId, containerId, tail ?? 200);
  });

  const logsStreamHandler = async (request: any, reply: any) => {
    const { hostId, containerId } = containerParamSchema.parse(request.params);
    const { tail } = containerTailQuerySchema.parse(request.query);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let stop: () => void = () => undefined;
    let clientClosed = false;
    const write = (event: string, payload: unknown) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`${event === "message" ? "" : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => write("ping", { ok: true }), 25_000);
    request.raw.on("close", () => {
      clientClosed = true;
      clearInterval(heartbeat);
      stop();
    });

    try {
      const connectedStop = await streamContainerLogs(
        hostId,
        containerId,
        tail,
        (line) => write("message", { line }),
        (error) => write("error", { error: error.message })
      );
      if (clientClosed) connectedStop();
      else stop = connectedStop;
    } catch (error) {
      write("error", { error: error instanceof Error ? error.message : String(error) });
      clearInterval(heartbeat);
      reply.raw.end();
    }
  };
  app.get("/api/hosts/:hostId/containers/:containerId/logs-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, logsStreamHandler);
  app.get("/api/v1/hosts/:hostId/containers/:containerId/logs-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, logsStreamHandler);

  app.get("/api/hosts/:hostId/containers/:containerId/stats", { preHandler: viewer }, async (request) => {
    const { hostId, containerId } = containerParamSchema.parse(request.params);
    return { stats: await getContainerStats(hostId, containerId) };
  });

  app.get("/api/hosts/:hostId/containers/:containerId/inspect", { preHandler: viewer }, async (request) => {
    const { hostId, containerId } = containerParamSchema.parse(request.params);
    const inspect = await getContainerInspect(hostId, containerId);
    return {
      inspect: inspectEnvRoles.has(request.user?.role ?? "") ? inspect : redactInspectEnv(inspect)
    };
  });

  const usageHandler = async (request: any) => {
    const { hostId } = request.params as { hostId: string };
    return { usage: await getContainerUsage(hostId) };
  };
  app.get("/api/hosts/:hostId/containers/usage", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, usageHandler);
  app.get("/api/v1/hosts/:hostId/containers/usage", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, usageHandler);

  const usageStreamHandler = async (request: any, reply: any) => {
    const { hostId } = request.params as { hostId: string };
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let stop: () => void = () => undefined;
    let clientClosed = false;
    const write = (event: string, payload: unknown) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`${event === "message" ? "" : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => write("ping", { ok: true }), 25_000);
    request.raw.on("close", () => {
      clientClosed = true;
      clearInterval(heartbeat);
      stop();
    });

    try {
      const connectedStop = await streamContainerUsage(
        hostId,
        (stats) => write("message", { stats }),
        (error) => write("error", { error: error.message })
      );
      if (clientClosed) connectedStop();
      else stop = connectedStop;
    } catch (error) {
      write("error", { error: error instanceof Error ? error.message : String(error) });
      clearInterval(heartbeat);
      reply.raw.end();
    }
  };
  app.get("/api/hosts/:hostId/containers/usage-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, usageStreamHandler);
  app.get("/api/v1/hosts/:hostId/containers/usage-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, usageStreamHandler);

  app.post("/api/hosts/:hostId/containers/:containerId/backups", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { hostId, containerId } = request.params as { hostId: string; containerId: string };
    const mounts = await getContainerVolumeMounts(hostId, containerId);
    if (mounts.length === 0) {
      reply.code(400);
      return { error: "Container has no named Docker volumes to back up" };
    }
    const { backups, jobs } = await createVolumeBackupsWithJobs(
      hostId,
      mounts.map((mount: { name: string }) => mount.name),
      request.user?.id
    );
    for (let index = 0; index < mounts.length; index += 1) {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId,
        action: "container.volume_backup",
        targetKind: "container",
        targetId: containerId,
        details: { volumeName: mounts[index]!.name, backupId: backups[index]!.id }
      });
    }
    return { backups, jobs };
  });

  app.post("/api/hosts/:hostId/containers/:containerId/exec", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId, containerId } = request.params as { hostId: string; containerId: string };
    const body = containerExecRequestSchema.parse(request.body);
    // Record the high-risk attempt before execution so a Docker rejection or
    // transport failure cannot erase the audit trail. Command text is never
    // retained.
    await writeAuditEvent({
      userId: request.user?.id,
      hostId,
      action: "container.exec",
      targetKind: "container",
      targetId: containerId,
      details: { commandRedacted: true },
      ...auditContextFromRequest(request)
    });
    return execInContainer(hostId, containerId, body.command);
  });

  app.post("/api/migrations/volume-clone", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = volumeCloneSchema.parse(request.body);
    const result = await createVolumeCloneWithJob(
      body,
      request.user?.id,
      async (client, created) => writeAuditEvent({
        userId: request.user?.id,
        hostId: body.sourceHostId,
        action: "volume.clone",
        targetKind: "backup",
        targetId: created.backup.id,
        details: {
          targetHostId: body.targetHostId,
          overwrite: body.overwrite
        },
        ...auditContextFromRequest(request)
      }, client)
    );
    return result;
  });

  app.post("/api/migrations/container-clone", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = containerCloneSchema.parse(request.body);
    const job = await withTransaction(async (client) => {
      const queued = await enqueueJobInTransaction(
        client,
        { type: "container.clone", hostId: body.sourceHostId, payload: { targetHostId: body.targetHostId, containerId: body.containerId, targetName: body.targetName, start: body.start } },
        request.user?.id
      );
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: body.sourceHostId,
        action: "container.clone",
        targetKind: "container",
        targetId: body.containerId,
        details: {
          targetHostId: body.targetHostId,
          start: body.start
        },
        ...auditContextFromRequest(request)
      }, client);
      return queued;
    });
    await notifyJobQueued(job.id);
    return { job };
  });
}
