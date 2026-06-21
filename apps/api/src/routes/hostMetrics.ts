import type { FastifyInstance } from "fastify";
import { idSchema } from "@composebastion/shared";
import { z } from "zod";
import { requireRole } from "../services/auth.js";
import { getFleetHostSnapshot, getHostMetricsSnapshot, streamHostStats } from "../services/hostMetrics.js";
import { listHosts } from "../services/hosts.js";
import { streamRateLimit } from "../services/rateLimits.js";

const hostParamSchema = z.object({
  hostId: idSchema
});

export async function registerHostMetricRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);

  app.get("/api/hosts/:hostId/metrics", { preHandler: viewer }, async (request) => {
    const { hostId } = hostParamSchema.parse(request.params);
    return getHostMetricsSnapshot(hostId);
  });

  const metricsStreamHandler = async (request: any, reply: any) => {
    const { hostId } = hostParamSchema.parse(request.params);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    let stop: () => void = () => undefined;
    const write = (event: string, payload: unknown) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`${event === "message" ? "" : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`);
    };
    const heartbeat = setInterval(() => write("ping", { ok: true }), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      stop();
    });

    try {
      stop = await streamHostStats(
        hostId,
        (stats) => write("message", { stats }),
        (error) => write("error", { error: error.message })
      );
    } catch (error) {
      write("error", { error: error instanceof Error ? error.message : String(error) });
      clearInterval(heartbeat);
      reply.raw.end();
    }
  };
  app.get("/api/hosts/:hostId/metrics-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, metricsStreamHandler);
  app.get("/api/v1/hosts/:hostId/metrics-stream", { preHandler: viewer, config: { rateLimit: streamRateLimit } }, metricsStreamHandler);

  app.get("/api/hosts/metrics", { preHandler: viewer }, async () => {
    const hosts = await listHosts();
    const results = await Promise.allSettled(hosts.map(async (host) => {
      const snapshot = await getFleetHostSnapshot(host.id);
      return { hostId: host.id, name: host.name, online: true, ...snapshot };
    }));

    return results.map((result, index) => {
      const host = hosts[index];
      if (result.status === "fulfilled") return result.value;
      return {
        hostId: host?.id ?? "unknown",
        name: host?.name ?? "Unknown host",
        online: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      };
    });
  });
}
