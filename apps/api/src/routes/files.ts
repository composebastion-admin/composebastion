import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listHostDirectory, normalizeRemotePath, readHostTextFile, statHostPath, writeHostTextFile } from "../services/files.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { hostFileRateLimit } from "../services/rateLimits.js";

const pathQuerySchema = z.object({
  path: z.string().min(1).max(1024).default("/")
});

const writeFileSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(512 * 1024)
});

export async function registerFileRoutes(app: FastifyInstance) {
  // Host file browsing/reading runs over SSH as the host's configured user, which on a
  // Docker host is typically root or a docker-group account. That means these endpoints
  // can reach anything that user can read (secrets, keys, other apps' data), so they are
  // gated at operator rather than viewer, and reads/writes are audited.
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/hosts/:hostId/files", { preHandler: operator, config: { rateLimit: hostFileRateLimit } }, async (request) => {
    const { hostId } = request.params as { hostId: string };
    const query = pathQuerySchema.parse(request.query);
    return { directory: await listHostDirectory(hostId, query.path) };
  });

  app.get("/api/hosts/:hostId/files/read", { preHandler: operator, config: { rateLimit: hostFileRateLimit } }, async (request) => {
    const { hostId } = request.params as { hostId: string };
    const query = pathQuerySchema.parse(request.query);
    const file = await readHostTextFile(hostId, query.path);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId,
      action: "host.file.read",
      targetKind: "file",
      targetId: normalizeRemotePath(query.path),
      ...auditContextFromRequest(request)
    });
    return { file };
  });

  app.get("/api/hosts/:hostId/files/exists", { preHandler: operator, config: { rateLimit: hostFileRateLimit } }, async (request) => {
    const { hostId } = request.params as { hostId: string };
    const query = pathQuerySchema.parse(request.query);
    return { file: await statHostPath(hostId, query.path) };
  });

  app.post("/api/hosts/:hostId/files/write", { preHandler: operator, config: { rateLimit: hostFileRateLimit } }, async (request) => {
    const { hostId } = request.params as { hostId: string };
    const body = writeFileSchema.parse(request.body);
    const file = await writeHostTextFile(hostId, body.path, body.content);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId,
      action: "host.file.write",
      targetKind: "file",
      targetId: normalizeRemotePath(body.path),
      ...auditContextFromRequest(request)
    });
    return { file };
  });
}
