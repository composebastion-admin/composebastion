import type { FastifyInstance } from "fastify";
import { createRegistry, deleteRegistry, listRegistries } from "../services/registries.js";
import { enqueueJob } from "../services/jobs.js";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerRegistryRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/registries", { preHandler: operator }, async () => ({ registries: await listRegistries() }));
  app.post("/api/registries", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const registry = await createRegistry(request.body);
    await writeAuditEvent({ userId: request.user?.id, action: "registry.create", targetKind: "registry", targetId: registry.id });
    return { registry };
  });
  app.delete("/api/registries/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteRegistry(id);
    return { ok: true };
  });
  app.post("/api/hosts/:hostId/registries/:registryId/login", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId, registryId } = request.params as { hostId: string; registryId: string };
    const job = await enqueueJob({ type: "registry.login", hostId, payload: { registryId } }, request.user?.id);
    await writeAuditEvent({ userId: request.user?.id, hostId, action: "registry.login", targetKind: "registry", targetId: registryId });
    return { job };
  });
}
