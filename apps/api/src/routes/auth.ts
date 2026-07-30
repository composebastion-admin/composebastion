import type { FastifyInstance } from "fastify";
import { idSchema, loginRequestSchema, setupRequestSchema } from "@composebastion/shared";
import { z } from "zod";
import {
  adminCount,
  clearSessionCookie,
  createLoginSession,
  destroyAllSessionsForUser,
  destroySession,
  hashToken,
  listSessionsForUser,
  readSession,
  revokeSessionForUser,
  setSessionCookie,
  setupInitialAdmin,
  verifyAdmin
} from "../services/auth.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { isLoginLocked, recordLoginAttempt } from "../services/loginAttempts.js";
import { sendApiError } from "../services/apiError.js";
import { authenticatedReadRateLimit, sensitiveMutationRateLimit } from "../services/rateLimits.js";

const sessionParamSchema = z.object({
  id: idSchema
});

export async function registerAuthRoutes(app: FastifyInstance) {
  const setupRateLimit = { max: 3, timeWindow: "10 minutes" };
  // Must stay above the per-IP lockout threshold (MAX_IP_FAILURES in
  // loginAttempts) so the lockout fires first and surfaces ACCOUNT_LOCKED; a
  // limit at or below the threshold shadows the lockout with a generic 429.
  const loginRateLimit = { max: 20, timeWindow: "5 minutes" };

  app.get("/api/auth/setup-state", { config: { rateLimit: authenticatedReadRateLimit } }, async () => ({
    needsSetup: (await adminCount()) === 0
  }));

  app.post("/api/auth/setup", { config: { rateLimit: setupRateLimit } }, async (request, reply) => {
    const body = setupRequestSchema.parse(request.body);
    const setupContext = auditContextFromRequest(request);
    const { user, session } = await setupInitialAdmin(
      body,
      setupContext,
      async (client, created) => {
        await writeAuditEvent({
          userId: created.id,
          action: "auth.setup",
          targetKind: "user",
          targetId: created.id,
          details: { includeDemoData: body.includeDemoData },
          ...setupContext
        }, client);
      }
    );
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user };
  });

  app.post("/api/auth/login", { config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const identifier = body.identifier ?? body.email ?? "";
    const ipAddress = request.ip ?? "unknown";
    const loginContext = auditContextFromRequest(request);
    if (await isLoginLocked(identifier, ipAddress)) {
      await writeAuditEvent({
        action: "auth.lockout",
        targetKind: "authentication",
        details: { reason: "failure_threshold" },
        ...loginContext
      });
      return sendApiError(reply, 429, "ACCOUNT_LOCKED", "Too many failed login attempts. Try again later.");
    }

    const user = await verifyAdmin(identifier, body.password);
    if (!user) {
      await recordLoginAttempt(
        identifier,
        ipAddress,
        false,
        async (client) => {
          await writeAuditEvent({
            action: "auth.login_failed",
            targetKind: "authentication",
            details: { reason: "invalid_credentials" },
            ...loginContext
          }, client);
        }
      );
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Invalid username/email or password");
    }

    await recordLoginAttempt(identifier, ipAddress, true);
    const session = await createLoginSession(
      user.id,
      loginContext,
      async (client) => {
        await writeAuditEvent({
          userId: user.id,
          action: "auth.login",
          targetKind: "user",
          targetId: user.id,
          ...loginContext
        }, client);
      }
    );
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const logoutContext = auditContextFromRequest(request);
    await destroySession(
      request.cookies.cb_session,
      async (client, userId) => {
        await writeAuditEvent({
          userId,
          action: "auth.logout",
          targetKind: "user",
          targetId: userId,
          ...logoutContext
        }, client);
      }
    );
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout-all", { config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    const ctx = auditContextFromRequest(request);
    await destroyAllSessionsForUser(user.id, async (client) => {
      await writeAuditEvent({
        userId: user.id,
        action: "auth.logout_all",
        targetKind: "user",
        targetId: user.id,
        ...ctx
      }, client);
    });
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/sessions", { config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    const currentHash = request.cookies.cb_session ? hashToken(request.cookies.cb_session) : "";
    await writeAuditEvent({
      userId: user.id,
      action: "auth.sessions_read",
      targetKind: "session",
      ...auditContextFromRequest(request)
    });
    return { sessions: await listSessionsForUser(user.id, currentHash) };
  });

  app.delete("/api/auth/sessions/:id", { config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    const { id } = sessionParamSchema.parse(request.params);
    const currentHash = request.cookies.cb_session ? hashToken(request.cookies.cb_session) : "";
    const ctx = auditContextFromRequest(request);
    const result = await revokeSessionForUser(
      id,
      user.id,
      currentHash,
      async (client) => {
        await writeAuditEvent({
          userId: user.id,
          action: "auth.session.revoke",
          targetKind: "session",
          targetId: id,
          ...ctx
        }, client);
      }
    );
    if (!result.revoked) {
      return sendApiError(reply, 404, "NOT_FOUND", "Session not found");
    }
    if (result.wasCurrent) clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { config: { rateLimit: authenticatedReadRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    return { user };
  });
}
