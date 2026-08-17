import type { FastifyInstance } from "fastify";
import { requireRole } from "../services/auth.js";
import { deleteCustomCatalogTemplate, deployCatalogTemplate, listCatalogTemplates, listExternalCatalogCandidates, saveCustomCatalogTemplate } from "../services/catalog.js";
import { writeAuditEvent, auditContextFromRequest } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerCatalogRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/catalog/templates", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    templates: await listCatalogTemplates()
  }));

  app.get("/api/catalog/external", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => (
    await listExternalCatalogCandidates(request.query)
  ));

  app.post("/api/catalog/templates", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const template = await saveCustomCatalogTemplate(
      request.body,
      request.user?.id,
      async (client, saved) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "catalog.template_save",
          targetKind: "catalog_template",
          targetId: saved.id,
          details: { name: saved.name, category: saved.category },
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return { template };
  });

  app.delete("/api/catalog/templates/:templateId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { templateId } = request.params as { templateId: string };
    const result = await deleteCustomCatalogTemplate(
      decodeURIComponent(templateId),
      async (client, deleted) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "catalog.template_delete",
          targetKind: "catalog_template",
          targetId: deleted.templateId,
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return result;
  });

  app.post("/api/catalog/deploy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const result = await deployCatalogTemplate(
      request.body,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.stack.hostId,
          action: "catalog.deploy",
          targetKind: "compose_stack",
          targetId: queued.stack.id,
          details: {
            templateId: queued.templateId,
            projectName: queued.stack.projectName
          },
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return result;
  });
}
