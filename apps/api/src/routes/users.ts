import type { FastifyInstance } from "fastify";
import { createUser, deleteUser, listUsers, updateUser } from "../services/users.js";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerUserRoutes(app: FastifyInstance) {
  const ownerOrAdmin = requireRole(["owner", "admin"]);

  app.get("/api/users", { preHandler: ownerOrAdmin, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({ users: await listUsers() }));

  app.post("/api/users", { preHandler: ownerOrAdmin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const user = await createUser(request.body);
    await writeAuditEvent({ userId: request.user?.id, action: "user.create", targetKind: "user", targetId: user.id });
    return { user };
  });

  app.put("/api/users/:id", { preHandler: ownerOrAdmin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await updateUser(id, request.body);
    if (!user) {
      reply.code(404);
      return { error: "User not found" };
    }
    await writeAuditEvent({ userId: request.user?.id, action: "user.update", targetKind: "user", targetId: id });
    return { user };
  });

  app.delete("/api/users/:id", { preHandler: ownerOrAdmin, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await deleteUser(id);
      await writeAuditEvent({ userId: request.user?.id, action: "user.delete", targetKind: "user", targetId: id });
      return { ok: true };
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      if (statusCode === 409) {
        reply.code(409);
        return { error: error instanceof Error ? error.message : "Conflict", code: "CONFLICT" };
      }
      throw error;
    }
  });
}
