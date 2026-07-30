import type { FastifyInstance } from "fastify";
import { createFavoriteImage, deleteFavoriteImage, listFavoriteImages } from "../services/favorites.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerFavoriteRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/favorite-images", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    images: await listFavoriteImages()
  }));

  app.post("/api/favorite-images", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const image = await createFavoriteImage(request.body, async (client, saved) => {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "favorite_image.save",
        targetKind: "favorite_image",
        targetId: saved.id,
        details: { image: saved.image },
        ...auditContextFromRequest(request)
      }, client);
    });
    return { image };
  });

  app.delete("/api/favorite-images/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteFavoriteImage(id, async (client) => {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "favorite_image.delete",
        targetKind: "favorite_image",
        targetId: id,
        ...auditContextFromRequest(request)
      }, client);
    });
    return { ok: true };
  });
}
