import type { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import {
  composeStackCreateSchema,
  composeStackProxyUpdateSchema,
  composeStackUpdateSchema,
  stackRollbackSchema
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import { requireRole } from "../services/auth.js";
import { enqueueJob } from "../services/jobs.js";
import { mapStack } from "../services/mappers.js";
import { writeAuditEvent, auditContextFromRequest } from "../services/audit.js";
import { buildProxySnippets, mergeTraefikLabelsIntoCompose } from "../services/proxySnippets.js";
import {
  diffStackVersions,
  listStackVersions,
  recordStackVersion,
  rollbackStackVersion
} from "../services/stackVersions.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

const stackSelect = `
  SELECT s.*, v.version_number AS current_version_number
  FROM compose_stacks s
  LEFT JOIN compose_stack_versions v ON v.id = s.current_version_id
`;

export async function registerComposeRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/hosts/:id/compose", { preHandler: viewer }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await query(`${stackSelect} WHERE s.host_id = $1 ORDER BY s.name ASC`, [id]);
    return { stacks: result.rows.map(mapStack) };
  });

  app.post("/api/hosts/:id/compose", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = composeStackCreateSchema.parse(request.body);
    const result = await query(
      `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [uuid(), id, body.name, body.projectName, body.composeYaml, body.env]
    );
    const stack = mapStack(result.rows[0]);
    await recordStackVersion({
      stackId: stack.id,
      composeYaml: stack.composeYaml,
      env: stack.env,
      source: "ui",
      createdBy: request.user?.id,
      note: "Initial stack create"
    });
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: id,
      action: "compose.create",
      targetKind: "compose_stack",
      targetId: stack.id,
      ...auditContextFromRequest(request)
    });
    return { stack };
  });

  app.put("/api/compose/:stackId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = composeStackUpdateSchema.parse(request.body);
    const current = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
    const row = current.rows[0];
    if (!row) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    const result = await query(
      `UPDATE compose_stacks
       SET name = $2, project_name = $3, compose_yaml = $4, env = $5, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        stackId,
        body.name ?? row.name,
        body.projectName ?? row.project_name,
        body.composeYaml ?? row.compose_yaml,
        body.env ?? row.env
      ]
    );
    const stack = mapStack(result.rows[0]);
    await recordStackVersion({
      stackId,
      composeYaml: stack.composeYaml,
      env: stack.env,
      source: "ui",
      createdBy: request.user?.id,
      note: "Stack updated from UI"
    });
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: row.host_id,
      action: "compose.update",
      targetKind: "compose_stack",
      targetId: stackId,
      ...auditContextFromRequest(request)
    });
    return { stack };
  });

  app.put("/api/compose/:stackId/proxy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = composeStackProxyUpdateSchema.parse(request.body);
    const current = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
    const row = current.rows[0];
    if (!row) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    const result = await query(
      `UPDATE compose_stacks
       SET domains = $2,
           exposed_service = $3,
           exposed_port = $4,
           tls_desired = $5,
           update_policy_enabled = $6,
           update_policy_channel = $7,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        stackId,
        body.domains ?? row.domains ?? [],
        body.exposedService ?? row.exposed_service,
        body.exposedPort ?? row.exposed_port,
        body.tlsDesired ?? row.tls_desired ?? false,
        body.updatePolicyEnabled ?? row.update_policy_enabled ?? false,
        body.updatePolicyChannel ?? row.update_policy_channel
      ]
    );
    return { stack: mapStack(result.rows[0]) };
  });

  app.get("/api/compose/:stackId/proxy/snippets", { preHandler: viewer }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const result = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
    const row = result.rows[0];
    if (!row) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    return buildProxySnippets({
      domains: row.domains ?? [],
      exposedService: row.exposed_service ?? null,
      exposedPort: row.exposed_port === null || row.exposed_port === undefined ? null : Number(row.exposed_port),
      tlsDesired: row.tls_desired ?? false,
      projectName: row.project_name
    });
  });

  app.post("/api/compose/:stackId/proxy/apply-labels", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const result = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
    const row = result.rows[0];
    if (!row) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    const snippets = buildProxySnippets({
      domains: row.domains ?? [],
      exposedService: row.exposed_service ?? null,
      exposedPort: row.exposed_port === null || row.exposed_port === undefined ? null : Number(row.exposed_port),
      tlsDesired: row.tls_desired ?? false,
      projectName: row.project_name
    });
    const serviceName = row.exposed_service ?? "app";
    const composeYaml = mergeTraefikLabelsIntoCompose(row.compose_yaml, serviceName, snippets.traefikLabels);
    const updated = await query(
      "UPDATE compose_stacks SET compose_yaml = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [stackId, composeYaml]
    );
    await recordStackVersion({
      stackId,
      composeYaml,
      env: row.env ?? "",
      source: "proxy_labels",
      createdBy: request.user?.id,
      note: "Merged Traefik labels into compose YAML"
    });
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: row.host_id,
      action: "compose.update",
      targetKind: "compose_stack",
      targetId: stackId,
      details: { proxyLabelsApplied: true, serviceName },
      ...auditContextFromRequest(request)
    });
    return { stack: mapStack(updated.rows[0]), warnings: snippets.warnings };
  });

  app.get("/api/compose/:stackId/versions", { preHandler: viewer }, async (request) => {
    const { stackId } = request.params as { stackId: string };
    return { versions: await listStackVersions(stackId) };
  });

  app.get("/api/compose/:stackId/versions/diff", { preHandler: viewer }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      reply.code(400);
      return { error: "from and to version ids are required" };
    }
    return diffStackVersions(stackId, from, to);
  });

  app.post("/api/compose/:stackId/rollback", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = stackRollbackSchema.parse(request.body);
    const stack = await query<any>("SELECT host_id FROM compose_stacks WHERE id = $1", [stackId]);
    if (!stack.rows[0]) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    const result = await rollbackStackVersion(stackId, body.versionId, request.user?.id, body.note);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: stack.rows[0].host_id,
      action: "compose.rollback",
      targetKind: "compose_stack",
      targetId: stackId,
      details: { versionId: body.versionId, versionNumber: result.version.versionNumber },
      ...auditContextFromRequest(request)
    });
    return result;
  });

  app.delete("/api/compose/:stackId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { stackId } = request.params as { stackId: string };
    await query("DELETE FROM compose_stacks WHERE id = $1", [stackId]);
    return { ok: true };
  });

  for (const action of ["deploy", "stop", "remove"] as const) {
    app.post(`/api/compose/:stackId/${action}`, { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
      const { stackId } = request.params as { stackId: string };
      const stack = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
      const row = stack.rows[0];
      if (!row) {
        reply.code(404);
        return { error: "Compose stack not found" };
      }
      if (action === "deploy") {
        await recordStackVersion({
          stackId,
          composeYaml: row.compose_yaml,
          env: row.env ?? "",
          source: "deploy",
          createdBy: request.user?.id,
          note: "Pre-deploy snapshot"
        });
      }
      const body = (request.body ?? {}) as { removeVolumes?: boolean };
      const type = `compose.${action}` as "compose.deploy" | "compose.stop" | "compose.remove";
      const payload = action === "remove" ? { stackId, removeVolumes: body.removeVolumes ?? false } : { stackId };
      const job = await enqueueJob({ type, hostId: row.host_id, payload } as Parameters<typeof enqueueJob>[0], request.user?.id);
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: row.host_id,
        action: type,
        targetKind: "compose_stack",
        targetId: stackId,
        ...auditContextFromRequest(request)
      });
      return { job };
    });
  }
}
