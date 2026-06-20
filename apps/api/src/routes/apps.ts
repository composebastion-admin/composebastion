import type { FastifyInstance } from "fastify";
import { appGithubVersionSelectSchema, appSourceLinkInputSchema } from "@dockermender/shared";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { requireRole } from "../services/auth.js";
import { checkAppUpdates, deleteAppSourceLink, listAppGithubVersions, listApps, selectAppGithubVersion, updateApp, upsertAppSourceLink } from "../services/apps.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerAppRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/apps", { preHandler: viewer }, async (request) => {
    const { hostId } = request.query as { hostId?: string };
    return { apps: await listApps(hostId) };
  });

  app.post("/api/apps/check-updates", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId } = (request.body ?? {}) as { hostId?: string };
    const apps = await checkAppUpdates(hostId);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: hostId ?? null,
      action: "app.update_check",
      targetKind: "app",
      targetId: hostId ?? "all",
      ...auditContextFromRequest(request)
    });
    return { apps };
  });

  app.get("/api/apps/:appId/versions", { preHandler: viewer }, async (request) => {
    const { appId } = request.params as { appId: string };
    return { versions: await listAppGithubVersions(decodeURIComponent(appId)) };
  });

  app.put("/api/apps/:appId/version", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { appId } = request.params as { appId: string };
    const body = appGithubVersionSelectSchema.parse(request.body);
    const result = await selectAppGithubVersion(decodeURIComponent(appId), body);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "app.version_select",
      targetKind: "app",
      targetId: appId,
      details: { ref: body.ref, kind: body.kind ?? null },
      ...auditContextFromRequest(request)
    });
    return result;
  });

  app.post("/api/apps/:appId/update", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { appId } = request.params as { appId: string };
    const result = await updateApp(decodeURIComponent(appId), request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "app.update",
      targetKind: "app",
      targetId: appId,
      ...auditContextFromRequest(request)
    });
    return result;
  });

  app.put("/api/apps/:appId/source", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { appId } = request.params as { appId: string };
    const link = await upsertAppSourceLink(decodeURIComponent(appId), appSourceLinkInputSchema.parse(request.body));
    await writeAuditEvent({
      userId: request.user?.id,
      action: "app.source_link",
      targetKind: "app",
      targetId: appId,
      details: { sourceType: link.sourceType },
      ...auditContextFromRequest(request)
    });
    return { link };
  });

  app.delete("/api/apps/:appId/source", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { appId } = request.params as { appId: string };
    const result = await deleteAppSourceLink(decodeURIComponent(appId));
    await writeAuditEvent({
      userId: request.user?.id,
      action: "app.source_unlink",
      targetKind: "app",
      targetId: appId,
      ...auditContextFromRequest(request)
    });
    return result;
  });
}
