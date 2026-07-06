import type { FastifyInstance } from "fastify";
import { githubRepositoryBranchesRequestSchema, githubRepositoryDeploySchema } from "@composebastion/shared";
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
import { writeAuditEvent } from "../services/audit.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerGithubRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/github/repos", { preHandler: viewer, config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    repositories: await listGithubRepositories()
  }));

  app.post("/api/github/repos", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const repository = await createGithubRepository(request.body);
    await writeAuditEvent({ userId: request.user?.id, action: "github_repo.create", targetKind: "github_repository", targetId: repository.id });
    return { repository };
  });

  app.post("/api/github/branches", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const body = githubRepositoryBranchesRequestSchema.parse(request.body);
    return { branches: await listGithubBranchesForUrl(body.repositoryUrl, body.githubToken) };
  });

  app.post("/api/github/access-check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => ({
    access: await testGithubRepositoryAccess(request.body)
  }));

  app.post("/api/github/repos/:id/access-check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await testGithubRepositoryStoredAccess(id);
    if (!result) {
      reply.code(404);
      return { error: "GitHub repository not found" };
    }
    await writeAuditEvent({ userId: request.user?.id, action: "github_repo.access_check", targetKind: "github_repository", targetId: id });
    return result;
  });

  app.get("/api/github/repos/:id/branches", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    return { branches: await listGithubBranchesForRepository(id) };
  });

  app.get("/api/github/repos/:id/compose", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const { branch } = request.query as { branch?: string };
    return previewGithubRepositoryCompose(id, branch);
  });

  app.put("/api/github/repos/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await updateGithubRepository(id, request.body);
    if (!repository) {
      reply.code(404);
      return { error: "GitHub repository not found" };
    }
    await writeAuditEvent({ userId: request.user?.id, action: "github_repo.update", targetKind: "github_repository", targetId: id });
    return { repository };
  });

  app.delete("/api/github/repos/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteGithubRepository(id);
    if (!deleted) {
      return { ok: false };
    }
    await writeAuditEvent({ userId: request.user?.id, action: "github_repo.delete", targetKind: "github_repository", targetId: id });
    return { ok: true };
  });

  app.post("/api/github/repos/:id/deploy", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = githubRepositoryDeploySchema.parse(request.body ?? {});
    const result = await deployGithubRepository(id, body, request.user?.id);
    await writeAuditEvent({ userId: request.user?.id, hostId: result.stack?.hostId ?? result.job?.hostId ?? body.hostId, action: "github_repo.deploy", targetKind: "github_repository", targetId: id });
    return result;
  });
}
