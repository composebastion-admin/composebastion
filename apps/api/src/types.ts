import type { AdminUser } from "@dockermender/shared";

declare module "fastify" {
  interface FastifyRequest {
    user?: AdminUser;
    requestId?: string;
  }
}
