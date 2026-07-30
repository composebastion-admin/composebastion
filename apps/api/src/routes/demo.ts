import type { FastifyInstance } from "fastify";
import { demoSeedRequestSchema } from "@composebastion/shared";
import { seedDemoWorkspace } from "../services/demo.js";
import { requireRole } from "../services/auth.js";
import { auditContextFromRequest } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

export async function registerDemoRoutes(app: FastifyInstance) {
  const operator = requireRole(["owner", "admin", "operator"]);

  app.post("/api/demo/seed", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    demoSeedRequestSchema.parse(request.body ?? {});
    const result = await seedDemoWorkspace(request.user?.id, {
      ...auditContextFromRequest(request),
      source: "manual"
    });
    return result;
  });
}
