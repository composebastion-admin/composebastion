import type { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import {
  composeStackCreateSchema,
  composeStackProxyUpdateSchema,
  composeStackUpdateSchema,
  stackRollbackSchema
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { requireRole } from "../services/auth.js";
import {
  enqueueJobInTransaction,
  lockComposeStackForMutation,
  notifyJobQueued
} from "../services/jobs.js";
import { mapStack, redactStackSensitiveFields } from "../services/mappers.js";
import { writeAuditEvent, auditContextFromRequest } from "../services/audit.js";
import { buildProxySnippets, mergeTraefikLabelsIntoCompose } from "../services/proxySnippets.js";
import {
  diffStackVersions,
  listStackVersions,
  recordStackVersionInTransaction,
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
    if (request.user?.role !== "viewer") {
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: id,
        action: "compose.list_read",
        targetKind: "compose_stack",
        ...auditContextFromRequest(request)
      });
    }
    const result = await query(`${stackSelect} WHERE s.host_id = $1 ORDER BY s.name ASC`, [id]);
    const stacks = result.rows.map(mapStack);
    return {
      stacks: request.user?.role === "viewer"
        ? stacks.map(redactStackSensitiveFields)
        : stacks
    };
  });

  app.post("/api/hosts/:id/compose", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = composeStackCreateSchema.parse(request.body);
    const stack = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [uuid(), id, body.name, body.projectName, body.composeYaml, body.env]
      );
      const created = mapStack(result.rows[0]);
      await recordStackVersionInTransaction(client, {
        stackId: created.id,
        composeYaml: created.composeYaml,
        env: created.env,
        source: "ui",
        createdBy: request.user?.id,
        note: "Initial stack create"
      });
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: id,
        action: "compose.create",
        targetKind: "compose_stack",
        targetId: created.id,
        ...auditContextFromRequest(request)
      }, client);
      return created;
    });
    return { stack };
  });

  app.put("/api/compose/:stackId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = composeStackUpdateSchema.parse(request.body);
    const stack = await withTransaction(async (client) => {
      const row = await lockComposeStackForMutation<any>(client, stackId);
      if (!row) return null;
      const result = await client.query(
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
      const updated = mapStack(result.rows[0]);
      await recordStackVersionInTransaction(client, {
        stackId,
        composeYaml: updated.composeYaml,
        env: updated.env,
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
      }, client);
      return updated;
    });
    if (!stack) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    return { stack };
  });

  app.put("/api/compose/:stackId/proxy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = composeStackProxyUpdateSchema.parse(request.body);
    const stack = await withTransaction(async (client) => {
      const row = await lockComposeStackForMutation<any>(client, stackId);
      if (!row) return null;
      const result = await client.query(
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
      await writeAuditEvent({
        userId: request.user?.id,
        hostId: row.host_id,
        action: "compose.proxy.update",
        targetKind: "compose_stack",
        targetId: stackId,
        details: { proxyConfigurationUpdated: true },
        ...auditContextFromRequest(request)
      }, client);
      return mapStack(result.rows[0]);
    });
    if (!stack) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    return { stack };
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
    const applied = await withTransaction(async (client) => {
      const row = await lockComposeStackForMutation<any>(client, stackId);
      if (!row) return null;
      const snippets = buildProxySnippets({
        domains: row.domains ?? [],
        exposedService: row.exposed_service ?? null,
        exposedPort: row.exposed_port === null || row.exposed_port === undefined ? null : Number(row.exposed_port),
        tlsDesired: row.tls_desired ?? false,
        projectName: row.project_name
      });
      const serviceName = row.exposed_service ?? "app";
      const composeYaml = mergeTraefikLabelsIntoCompose(row.compose_yaml, serviceName, snippets.traefikLabels);
      const updated = await client.query(
        "UPDATE compose_stacks SET compose_yaml = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [stackId, composeYaml]
      );
      await recordStackVersionInTransaction(client, {
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
      }, client);
      return {
        stack: mapStack(updated.rows[0]),
        warnings: snippets.warnings
      };
    });
    if (!applied) {
      reply.code(404);
      return { error: "Compose stack not found" };
    }
    return applied;
  });

  app.get("/api/compose/:stackId/versions", { preHandler: operator }, async (request) => {
    const { stackId } = request.params as { stackId: string };
    await writeAuditEvent({
      userId: request.user?.id,
      action: "compose.versions_read",
      targetKind: "compose_stack",
      targetId: stackId,
      ...auditContextFromRequest(request)
    });
    return { versions: await listStackVersions(stackId) };
  });

  app.get("/api/compose/:stackId/versions/diff", { preHandler: operator }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const { from, to } = request.query as { from?: string; to?: string };
    if (!from || !to) {
      reply.code(400);
      return { error: "from and to version ids are required" };
    }
    await writeAuditEvent({
      userId: request.user?.id,
      action: "compose.version_diff_read",
      targetKind: "compose_stack",
      targetId: stackId,
      ...auditContextFromRequest(request)
    });
    return diffStackVersions(stackId, from, to);
  });

  app.post("/api/compose/:stackId/rollback", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { stackId } = request.params as { stackId: string };
    const body = stackRollbackSchema.parse(request.body);
    try {
      return await rollbackStackVersion(
        stackId,
        body.versionId,
        request.user?.id,
        body.note,
        async (client, queued) => {
          await writeAuditEvent({
            userId: request.user?.id,
            hostId: queued.job.hostId,
            action: "compose.rollback",
            targetKind: "compose_stack",
            targetId: stackId,
            details: {
              versionId: body.versionId,
              versionNumber: queued.version.versionNumber
            },
            ...auditContextFromRequest(request)
          }, client);
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Compose stack not found") {
        reply.code(404);
        return { error: error.message };
      }
      throw error;
    }
  });

  app.delete("/api/compose/:stackId", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { stackId } = request.params as { stackId: string };
    await withTransaction(async (client) => {
      const stack = await lockComposeStackForMutation<{ host_id: string }>(client, stackId);
      if (!stack) return;
      const result = await client.query<{ host_id: string }>(
        "DELETE FROM compose_stacks WHERE id = $1 RETURNING host_id",
        [stackId]
      );
      if (result.rows[0]) {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: result.rows[0].host_id,
          action: "compose.forget",
          targetKind: "compose_stack",
          targetId: stackId,
          details: { dockerResourcesRemoved: false },
          ...auditContextFromRequest(request)
        }, client);
      }
    });
    return { ok: true };
  });

  for (const action of ["deploy", "stop", "remove"] as const) {
    app.post(`/api/compose/:stackId/${action}`, { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
      const { stackId } = request.params as { stackId: string };
      const body = (request.body ?? {}) as { removeVolumes?: boolean };
      const type = `compose.${action}` as "compose.deploy" | "compose.stop" | "compose.remove";
      const transactionResult = await withTransaction(async (client) => {
        const row = await lockComposeStackForMutation<any>(client, stackId);
        if (!row) return null;
        if (action === "deploy") {
          await recordStackVersionInTransaction(client, {
            stackId,
            composeYaml: row.compose_yaml,
            env: row.env ?? "",
            source: "deploy",
            createdBy: request.user?.id,
            note: "Pre-deploy snapshot"
          });
        }
        const payload = action === "remove"
          ? { stackId, removeVolumes: body.removeVolumes ?? false }
          : { stackId };
        const job = await enqueueJobInTransaction(
          client,
          { type, hostId: row.host_id, payload } as Parameters<typeof enqueueJobInTransaction>[1],
          request.user?.id
        );
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: row.host_id,
          action: type,
          targetKind: "compose_stack",
          targetId: stackId,
          ...auditContextFromRequest(request)
        }, client);
        return { job };
      });
      if (!transactionResult) {
        reply.code(404);
        return { error: "Compose stack not found" };
      }
      await notifyJobQueued(transactionResult.job.id);
      return transactionResult;
    });
  }
}
