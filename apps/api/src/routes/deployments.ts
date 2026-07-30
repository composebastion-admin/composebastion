import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import {
  checkRegistryTrust,
  createDeploymentSource,
  createDeploymentAnalysis,
  deleteDeploymentSource,
  getDeploymentAnalysis,
  getDeploymentSource,
  listDeploymentSources,
  normalizeRegistryTrustAuthority,
  queueDeployment,
  updateDeploymentSource
} from "../services/deployments.js";
import { enqueueJob } from "../services/jobs.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

const registryBodySchema = z.object({
  registry: z.string().trim().min(1).max(255),
  insecure: z.boolean().default(true)
});

export async function registerDeploymentRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);
  const admin = requireRole(["owner", "admin"]);

  app.post("/api/deploy/analyses", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request, reply) => {
    const result = await createDeploymentAnalysis(request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.analysis.hostId,
      action: "deploy.analyze",
      targetKind: "deployment_analysis",
      targetId: result.analysis.id
    });
    reply.code(202);
    return result;
  });

  app.get("/api/deploy/analyses/:id", {
    preHandler: operator,
    config: { rateLimit: authenticatedReadRateLimit }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const analysis = await getDeploymentAnalysis(id);
    if (!analysis) {
      reply.code(404);
      return { error: "Deployment analysis not found" };
    }
    return { analysis };
  });

  app.post("/api/deploy/analyses/:id/deploy", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await queueDeployment(id, request.body, request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.analysis.hostId,
      action: "deploy.execute",
      targetKind: "deployment_analysis",
      targetId: id
    });
    reply.code(202);
    return result;
  });

  app.get("/api/deployment-sources", {
    preHandler: operator,
    config: { rateLimit: authenticatedReadRateLimit }
  }, async () => ({ sources: await listDeploymentSources() }));

  app.post("/api/deployment-sources", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request) => {
    const source = await createDeploymentSource(request.body);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "deployment_source.create",
      targetKind: "deployment_source",
      targetId: source.id
    });
    return { source };
  });

  app.get("/api/deployment-sources/:id", {
    preHandler: operator,
    config: { rateLimit: authenticatedReadRateLimit }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await getDeploymentSource(id);
    if (!source) {
      reply.code(404);
      return { error: "Deployment source not found" };
    }
    return { source };
  });

  app.put("/api/deployment-sources/:id", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await updateDeploymentSource(id, request.body);
    if (!source) {
      reply.code(404);
      return { error: "Deployment source not found" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      action: "deployment_source.update",
      targetKind: "deployment_source",
      targetId: id
    });
    return { source };
  });

  app.delete("/api/deployment-sources/:id", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const ok = await deleteDeploymentSource(id);
    if (ok) {
      await writeAuditEvent({
        userId: request.user?.id,
        action: "deployment_source.delete",
        targetKind: "deployment_source",
        targetId: id
      });
    }
    return { ok };
  });

  app.post("/api/hosts/:hostId/registry-trust/check", {
    preHandler: operator,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request) => {
    const { hostId } = request.params as { hostId: string };
    const body = registryBodySchema.parse(request.body);
    const registry = normalizeRegistryTrustAuthority(body.registry);
    return { registryTrust: await checkRegistryTrust(hostId, registry, body.insecure) };
  });

  app.post("/api/hosts/:hostId/registry-trust/apply", {
    preHandler: admin,
    config: { rateLimit: sensitiveMutationRateLimit }
  }, async (request, reply) => {
    const { hostId } = request.params as { hostId: string };
    const body = registryBodySchema.parse(request.body);
    if (!body.insecure) throw Object.assign(new Error("Only explicit HTTP registries require daemon trust configuration."), { statusCode: 400 });
    const registry = normalizeRegistryTrustAuthority(body.registry);
    const job = await enqueueJob(
      { type: "host.configureRegistryTrust", hostId, payload: { registry } },
      request.user?.id
    );
    await writeAuditEvent({
      userId: request.user?.id,
      hostId,
      action: "host.configure_registry_trust",
      targetKind: "docker_host",
      targetId: hostId,
      details: { registry }
    });
    reply.code(202);
    return { job };
  });
}
