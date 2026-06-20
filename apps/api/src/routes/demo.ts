import type { FastifyInstance } from "fastify";
import { demoSeedRequestSchema } from "@composebastion/shared";
import { seedDemoWorkspace } from "../services/demo.js";
import { requireRole } from "../services/auth.js";
import { writeAuditEvent } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerDemoRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.post("/api/demo/seed", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    demoSeedRequestSchema.parse(request.body ?? {});
    const result = await seedDemoWorkspace(request.user?.id);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: result.host.id,
      action: "demo.seed",
      targetKind: "host",
      targetId: result.host.id,
      details: { source: "manual" }
    });
    return result;
  });
}
