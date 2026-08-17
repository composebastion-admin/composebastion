import type { FastifyInstance } from "fastify";
import {
  createRegistry,
  deleteRegistry,
  enqueueRegistryLogin,
  listRegistries
} from "../services/registries.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerRegistryRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/registries", { preHandler: operator, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    await writeAuditEvent({
      userId: request.user?.id,
      action: "registry.list_read",
      targetKind: "registry",
      ...auditContextFromRequest(request)
    });
    return { registries: await listRegistries() };
  });
  app.post("/api/registries", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const registry = await createRegistry(request.body, {
      userId: request.user?.id,
      ...auditContextFromRequest(request)
    });
    return { registry };
  });
  app.delete("/api/registries/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteRegistry(id, {
      userId: request.user?.id,
      ...auditContextFromRequest(request)
    });
    return { ok: true };
  });
  app.post("/api/hosts/:hostId/registries/:registryId/login", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId, registryId } = request.params as { hostId: string; registryId: string };
    const job = await enqueueRegistryLogin(
      hostId,
      registryId,
      request.user?.id,
      auditContextFromRequest(request)
    );
    return { job };
  });
}
