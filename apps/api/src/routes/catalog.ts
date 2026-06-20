import type { FastifyInstance } from "fastify";
import { requireRole } from "../services/auth.js";
import { deleteCustomCatalogTemplate, deployCatalogTemplate, listCatalogTemplates, listExternalCatalogCandidates, saveCustomCatalogTemplate } from "../services/catalog.js";
import { writeAuditEvent, auditContextFromRequest } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerCatalogRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/catalog/templates", { preHandler: viewer }, async () => ({
    templates: await listCatalogTemplates()
  }));

  app.get("/api/catalog/external", { preHandler: viewer }, async (request) => (
    await listExternalCatalogCandidates(request.query)
  ));

  app.post("/api/catalog/templates", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const template = await saveCustomCatalogTemplate(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "catalog.template_save",
      targetKind: "catalog_template",
      targetId: template.id,
      details: { name: template.name, category: template.category },
      ...auditContextFromRequest(request)
    });
    return { template };
  });

  app.delete("/api/catalog/templates/:templateId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { templateId } = request.params as { templateId: string };
    const result = await deleteCustomCatalogTemplate(decodeURIComponent(templateId));
    await writeAuditEvent({
      userId: request.user?.id,
      action: "catalog.template_delete",
      targetKind: "catalog_template",
      targetId: result.templateId,
      ...auditContextFromRequest(request)
    });
    return result;
  });

  app.post("/api/catalog/deploy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const result = await deployCatalogTemplate(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.stack.hostId,
      action: "catalog.deploy",
      targetKind: "compose_stack",
      targetId: result.stack.id,
      details: { templateId: result.templateId, projectName: result.stack.projectName },
      ...auditContextFromRequest(request)
    });
    return result;
  });
}
