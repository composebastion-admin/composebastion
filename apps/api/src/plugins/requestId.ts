import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export async function registerRequestId(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" && incoming.trim() ? incoming.trim() : randomUUID();
    request.requestId = requestId;
    reply.header("X-Request-Id", requestId);
  });
}
