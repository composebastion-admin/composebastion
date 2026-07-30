import type { FastifyInstance } from "fastify";
import {
  githubRepositoryAccessCheckSchema,
  githubRepositoryBranchesRequestSchema,
  githubRepositoryDeploySchema
} from "@composebastion/shared";
import {
  createGithubRepository,
  deleteGithubRepository,
  deployGithubRepository,
  listGithubBranchesForRepository,
  listGithubBranchesForUrl,
  listGithubRepositories,
  previewGithubRepositoryCompose,
  testGithubRepositoryAccess,
  testGithubRepositoryStoredAccess,
  updateGithubRepository
} from "../services/github.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerGithubRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/github/repos", { preHandler: operator, config: { rateLimit: authenticatedReadRateLimit } }, async (request) => {
    await writeAuditEvent({
      userId: request.user?.id,
      action: "github_repo.list_read",
      targetKind: "github_repository",
      ...auditContextFromRequest(request)
    });
    return { repositories: await listGithubRepositories() };
  });

  app.post("/api/github/repos", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const repository = await createGithubRepository(
      request.body,
      async (client, created) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "github_repo.create",
          targetKind: "github_repository",
          targetId: created.id,
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return { repository };
  });

  app.post("/api/github/branches", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = githubRepositoryBranchesRequestSchema.parse(request.body);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "github_repo.branches_read",
      targetKind: "github_repository",
      details: { stored: false },
      ...auditContextFromRequest(request)
    });
    return { branches: await listGithubBranchesForUrl(body.repositoryUrl, body.githubToken) };
  });

  app.post("/api/github/access-check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = githubRepositoryAccessCheckSchema.parse(request.body);
    await writeAuditEvent({
      userId: request.user?.id,
      action: "github_repo.access_check",
      targetKind: "github_repository",
      details: { stored: false, phase: "intent" },
      ...auditContextFromRequest(request)
    });
    return { access: await testGithubRepositoryAccess(body) };
  });

  app.post("/api/github/repos/:id/access-check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await testGithubRepositoryStoredAccess(
      id,
      async (client, checked) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "github_repo.access_check",
          targetKind: "github_repository",
          targetId: id,
          details: { phase: "result", succeeded: checked.access.ok },
          ...auditContextFromRequest(request)
        }, client);
      },
      async () => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "github_repo.access_check",
          targetKind: "github_repository",
          targetId: id,
          details: { stored: true, phase: "intent" },
          ...auditContextFromRequest(request)
        });
      }
    );
    if (!result) {
      reply.code(404);
      return { error: "GitHub repository not found" };
    }
    return result;
  });

  app.get("/api/github/repos/:id/branches", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await writeAuditEvent({
      userId: request.user?.id,
      action: "github_repo.branches_read",
      targetKind: "github_repository",
      targetId: id,
      details: { stored: true },
      ...auditContextFromRequest(request)
    });
    return { branches: await listGithubBranchesForRepository(id) };
  });

  app.get("/api/github/repos/:id/compose", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const { branch } = request.query as { branch?: string };
    await writeAuditEvent({
      userId: request.user?.id,
      action: "github_repo.compose_read",
      targetKind: "github_repository",
      targetId: id,
      ...auditContextFromRequest(request)
    });
    return previewGithubRepositoryCompose(id, branch);
  });

  app.put("/api/github/repos/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await updateGithubRepository(
      id,
      request.body,
      async (client) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "github_repo.update",
          targetKind: "github_repository",
          targetId: id,
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    if (!repository) {
      reply.code(404);
      return { error: "GitHub repository not found" };
    }
    return { repository };
  });

  app.delete("/api/github/repos/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteGithubRepository(
      id,
      async (client) => {
        await writeAuditEvent({
          userId: request.user?.id,
          action: "github_repo.delete",
          targetKind: "github_repository",
          targetId: id,
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    if (!deleted) {
      return { ok: false };
    }
    return { ok: true };
  });

  app.post("/api/github/repos/:id/deploy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = githubRepositoryDeploySchema.parse(request.body ?? {});
    const result = await deployGithubRepository(
      id,
      body,
      request.user?.id,
      async (client, queued) => {
        await writeAuditEvent({
          userId: request.user?.id,
          hostId: queued.stack?.hostId ?? queued.job.hostId ?? body.hostId,
          action: "github_repo.deploy",
          targetKind: "github_repository",
          targetId: id,
          details: {
            mode: queued.mode,
            branch: queued.branch,
            sourceCommitSha: queued.sourceCommitSha ?? null,
            composeSha256: queued.composeSha256 ?? null,
            customCompose: queued.customCompose ?? false
          },
          ...auditContextFromRequest(request)
        }, client);
      }
    );
    return result;
  });
}
