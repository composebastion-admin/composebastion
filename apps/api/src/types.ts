import type { AdminUser } from "@composebastion/shared";

declare module "fastify" {
  interface FastifyRequest {
    user?: AdminUser;
    requestId?: string;
  }
}
