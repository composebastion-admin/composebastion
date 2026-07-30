import type { FastifyInstance } from "fastify";
import {
  appGithubVersionSelectSchema,
  appRenameInputSchema,
  appSourceLinkInputSchema,
  sanitizeGitRepositoryUrl,
  sanitizeUrlDiagnosticText,
  type DockerApp,
  type OperationJob
} from "@composebastion/shared";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { requireRole } from "../services/auth.js";
import { checkAppUpdates, deleteAppSourceLink, listAppGithubVersions, listApps, renameApp, selectAppGithubVersion, updateApp, upsertAppSourceLink } from "../services/apps.js";
import { sanitizeOperationJobForRead } from "../services/mappers.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

function redactViewerApp(app: DockerApp): DockerApp {
  const sanitized = sanitizeAppForRead(app);
  return {
    ...sanitized,
    sensitiveFieldsRedacted: true,
    sourceLink: sanitized.sourceLink ? {
      ...sanitized.sourceLink,
      workingDir: null,
      composePath: null,
      checkError: sanitized.sourceLink.checkError
        ? "Source check failed; details require operator access."
        : null
    } : null,
    update: {
      ...sanitized.update,
      riskNote: sanitized.update.riskNote
        ? "Update details require operator access."
        : sanitized.update.riskNote
    }
  };
}

function sanitizeAppForRead(app: DockerApp): DockerApp {
  return {
    ...app,
    repositoryUrl: sanitizeGitRepositoryUrl(app.repositoryUrl),
    sourceLink: app.sourceLink ? {
      ...app.sourceLink,
      repositoryUrl: sanitizeGitRepositoryUrl(app.sourceLink.repositoryUrl),
      checkError: sanitizeUrlDiagnosticText(app.sourceLink.checkError) as string | null
    } : null,
    update: {
      ...app.update,
      riskNote: sanitizeUrlDiagnosticText(app.update.riskNote) as typeof app.update.riskNote
    }
  };
}

function sanitizeAppUpdateResult<T>(result: T): T {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const source = result as Record<string, unknown>;
  const sanitized = { ...source };
  if (source.job && typeof source.job === "object" && !Array.isArray(source.job)) {
    sanitized.job = sanitizeOperationJobForRead(source.job as OperationJob);
  }
  if (Array.isArray(source.jobs)) {
    sanitized.jobs = source.jobs.map((job) => (
      job && typeof job === "object" && !Array.isArray(job)
        ? sanitizeOperationJobForRead(job as OperationJob)
        : job
    ));
  }
  return sanitized as T;
}

export async function registerAppRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/apps", { preHandler: viewer }, async (request) => {
    const { hostId } = request.query as { hostId?: string };
    const apps = (await listApps(hostId)).map(sanitizeAppForRead);
    return {
      apps: request.user?.role === "viewer"
        ? apps.map(redactViewerApp)
        : apps
    };
  });

  app.post("/api/apps/check-updates", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId } = (request.body ?? {}) as { hostId?: string };
    const apps = (await checkAppUpdates(hostId)).map(sanitizeAppForRead);
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

  app.get("/api/apps/:appId/versions", { preHandler: operator }, async (request) => {
    const { appId } = request.params as { appId: string };
    const versions = await listAppGithubVersions(decodeURIComponent(appId));
    return {
      versions: {
        ...versions,
        repositoryUrl: sanitizeGitRepositoryUrl(versions.repositoryUrl) ?? ""
      }
    };
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
    return {
      ...result,
      app: result.app ? sanitizeAppForRead(result.app) : null
    };
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
    return sanitizeAppUpdateResult(result);
  });

  app.put("/api/apps/:appId/name", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { appId } = request.params as { appId: string };
    const body = appRenameInputSchema.parse(request.body);
    const result = await renameApp(decodeURIComponent(appId), body);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "app.rename",
      targetKind: "app",
      targetId: appId,
      details: { name: body.name },
      ...auditContextFromRequest(request)
    });
    return {
      ...result,
      app: result.app ? sanitizeAppForRead(result.app) : null
    };
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
    return {
      link: {
        ...link,
        repositoryUrl: sanitizeGitRepositoryUrl(link.repositoryUrl),
        checkError: sanitizeUrlDiagnosticText(link.checkError) as string | null
      }
    };
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
