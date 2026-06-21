import type { FastifyInstance } from "fastify";
import { requireRole } from "../services/auth.js";
import { listAuditEvents } from "../services/audit.js";

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get("/api/audit", { preHandler: requireRole(["owner", "admin"]) }, async (request) => {
    const page = await listAuditEvents(request.query);
    return { events: page.items, ...page };
  });
}
