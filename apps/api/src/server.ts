import "./types.js";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerBackupScheduleRoutes } from "./routes/backupSchedules.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerAppRoutes } from "./routes/apps.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerComposeRoutes } from "./routes/compose.js";
import { registerImageIntelligenceRoutes } from "./routes/imageIntelligence.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerContainerRoutes } from "./routes/containers.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerFavoriteRoutes } from "./routes/favorites.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerHostRoutes } from "./routes/hosts.js";
import { registerHostMetricRoutes } from "./routes/hostMetrics.js";
import { registerHostTerminalRoutes } from "./routes/hostTerminal.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerRegistryRoutes } from "./routes/registries.js";
import { registerRecoveryCenterRoutes } from "./routes/recoveryCenter.js";
import { registerSelfUpdateRoutes } from "./routes/selfUpdate.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerRequestId } from "./plugins/requestId.js";
import { registerApiVersionAliasRoutes } from "./routes/apiVersion.js";
import { isAllowedCorsOrigin, isTrustedUnsafeRequestOrigin, isUnsafeHttpMethod } from "./services/httpSecurity.js";
import { createRedis, redisErrorType } from "./services/redis.js";
import { getWorkerStatus } from "./services/jobs.js";
import { sendApiError } from "./services/apiError.js";
import { apiLogFields } from "./services/operationLogs.js";
import { healthCheckRateLimit } from "./services/rateLimits.js";
import { runtimeVersionMetadata } from "./services/version.js";

export async function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024, trustProxy: env.TRUST_PROXY, requestIdHeader: "x-request-id", genReqId: (req) => {
    const incoming = req.headers["x-request-id"];
    return typeof incoming === "string" && incoming.trim() ? incoming.trim() : randomUUID();
  } });

  await registerRequestId(app);
  const requestStartTimes = new WeakMap<object, number>();
  app.addHook("onRequest", async (request) => {
    requestStartTimes.set(request, Date.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    if (!request.raw.url?.startsWith("/api/")) return;
    app.log.info(apiLogFields(request, reply, requestStartTimes.get(request) ?? Date.now()), "api.request");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: "Validation failed", code: "VALIDATION_FAILED", requestId: request.id, issues: error.issues });
      return;
    }
    app.log.error(error);
    const statusCode = Number((error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status ?? 500);
    const safeMessage = env.NODE_ENV === "production" && statusCode >= 500
      ? "Internal server error"
      : error instanceof Error ? error.message : "Internal server error";
    const code = statusCode === 409 ? "CONFLICT" : statusCode === 403 ? "FORBIDDEN" : statusCode === 401 ? "AUTH_REQUIRED" : statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_FAILED";
    reply.code(statusCode).send({ error: safeMessage, code, requestId: request.id });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "upgrade-insecure-requests": env.SECURE_COOKIES ? [] : null
      }
    }
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute"
  });
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin, env.CORS_ORIGINS, env.NODE_ENV));
    }
  });
  await app.register(cookie);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.raw.url?.startsWith("/api/")) return;
    if (!isUnsafeHttpMethod(request.method)) return;
    if (isTrustedUnsafeRequestOrigin(request.headers.origin, request.headers.host, env.CORS_ORIGINS, env.NODE_ENV)) return;
    return sendApiError(reply, 403, "FORBIDDEN", "Origin is not allowed for mutating API requests");
  });

  app.get("/api/health", async () => ({ ok: true, ...runtimeVersionMetadata() }));
  app.get("/api/health/db", { config: { rateLimit: healthCheckRateLimit } }, async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/health/ready", { config: { rateLimit: healthCheckRateLimit } }, async (_request, reply) => {
    const checks: Record<string, { ok: boolean; required: boolean; error?: string }> = {};
    try {
      await pool.query("SELECT 1");
      checks.database = { ok: true, required: true };
    } catch (error) {
      checks.database = { ok: false, required: true, error: error instanceof Error ? error.message : "Database unavailable" };
    }

    const redis = createRedis();
    if (!redis) {
      checks.redis = { ok: false, required: false, error: "Redis not configured" };
    } else {
      try {
        await redis.connect();
        checks.redis = { ok: (await redis.ping()) === "PONG", required: false };
      } catch (error) {
        checks.redis = { ok: false, required: false, error: redisErrorType(error) };
      } finally {
        redis.disconnect();
      }
    }

    try {
      accessSync(env.BACKUP_DIR, constants.W_OK | constants.R_OK);
      checks.backups = { ok: true, required: false };
    } catch (error) {
      checks.backups = { ok: false, required: false, error: error instanceof Error ? error.message : "Backup directory unavailable" };
    }

    try {
      const worker = await getWorkerStatus();
      checks.worker = {
        ok: worker.available,
        required: true,
        ...worker,
        ...(worker.available ? {} : { error: `Worker is ${worker.state}` })
      };
    } catch (error) {
      checks.worker = { ok: false, required: true, error: error instanceof Error ? error.message : "Worker status unavailable" };
    }

    const ok = Object.values(checks).filter((check) => check.required).every((check) => check.ok);
    if (!ok) reply.code(503);
    return { ok, checks };
  });
  app.get("/api/health/redis", { config: { rateLimit: healthCheckRateLimit } }, async (_request, reply) => {
    const redis = createRedis();
    if (!redis) {
      reply.code(503).send({ ok: false, configured: false });
      return;
    }
    try {
      await redis.connect();
      const pong = await redis.ping();
      const ok = pong === "PONG";
      if (!ok) reply.code(503);
      return { ok, configured: true };
    } catch (error) {
      reply.code(503).send({
        ok: false,
        configured: true,
        error: redisErrorType(error)
      });
    } finally {
      redis.disconnect();
    }
  });

  const apiNotFoundHandler = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.raw.url?.startsWith("/api/")) {
      sendApiError(reply, 404, "NOT_FOUND", "Not found");
      return;
    }
    reply.code(404).send({ error: "Not found", code: "NOT_FOUND", requestId: request.id });
  };

  await registerAuthRoutes(app);
  await registerAuditRoutes(app);
  await registerHostRoutes(app);
  await registerHostTerminalRoutes(app);
  await registerAppRoutes(app);
  await registerContainerRoutes(app);
  await registerDemoRoutes(app);
  await registerComposeRoutes(app);
  await registerCatalogRoutes(app);
  await registerImageIntelligenceRoutes(app);
  await registerBackupRoutes(app);
  await registerBackupScheduleRoutes(app);
  await registerRecoveryCenterRoutes(app);
  await registerAlertRoutes(app);
  await registerConfigRoutes(app);
  await registerFavoriteRoutes(app);
  await registerFileRoutes(app);
  await registerGithubRoutes(app);
  await registerHostMetricRoutes(app);
  await registerRegistryRoutes(app);
  await registerSelfUpdateRoutes(app);
  await registerUserRoutes(app);
  await registerJobRoutes(app);
  await registerApiVersionAliasRoutes(app);

  const webRoot = env.WEB_DIST_DIR ?? path.resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        sendApiError(reply, 404, "NOT_FOUND", "Not found");
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(apiNotFoundHandler);
  }

  return app;
}

async function main() {
  await runMigrations();
  const app = await buildServer();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
