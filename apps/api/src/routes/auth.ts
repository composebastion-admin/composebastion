import type { FastifyInstance } from "fastify";
import { idSchema, loginRequestSchema, setupRequestSchema } from "@dockermender/shared";
import { z } from "zod";
import {
  adminCount,
  clearSessionCookie,
  createAdmin,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  hashToken,
  listSessionsForUser,
  readSession,
  revokeSessionForUser,
  setSessionCookie,
  touchLastLogin,
  verifyAdmin
} from "../services/auth.js";
import { seedDemoWorkspace } from "../services/demo.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { isLoginLocked, recordLoginAttempt } from "../services/loginAttempts.js";
import { sendApiError } from "../services/apiError.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

const sessionParamSchema = z.object({
  id: idSchema
});

export async function registerAuthRoutes(app: FastifyInstance) {
  const setupRateLimit = { max: 3, timeWindow: "10 minutes" };
  // Must stay above the per-IP lockout threshold (MAX_IP_FAILURES in
  // loginAttempts) so the lockout fires first and surfaces ACCOUNT_LOCKED; a
  // limit at or below the threshold shadows the lockout with a generic 429.
  const loginRateLimit = { max: 20, timeWindow: "5 minutes" };

  app.get("/api/auth/setup-state", async () => ({
    needsSetup: (await adminCount()) === 0
  }));

  app.post("/api/auth/setup", { config: { rateLimit: setupRateLimit } }, async (request, reply) => {
    const body = setupRequestSchema.parse(request.body);
    const user = await createAdmin(body);
    if (body.includeDemoData) {
      await seedDemoWorkspace(user.id);
    }
    const session = await createSession(user.id, auditContextFromRequest(request));
    await touchLastLogin(user.id);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user };
  });

  app.post("/api/auth/login", { config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const identifier = body.identifier ?? body.email ?? "";
    const ipAddress = request.ip ?? "unknown";
    if (await isLoginLocked(identifier, ipAddress)) {
      return sendApiError(reply, 429, "ACCOUNT_LOCKED", "Too many failed login attempts. Try again later.");
    }

    const user = await verifyAdmin(identifier, body.password);
    if (!user) {
      await recordLoginAttempt(identifier, ipAddress, false);
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Invalid username/email or password");
    }

    await recordLoginAttempt(identifier, ipAddress, true);
    const session = await createSession(user.id, auditContextFromRequest(request));
    await touchLastLogin(user.id);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(request.cookies.dm_session);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/logout-all", { config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    await destroyAllSessionsForUser(user.id);
    clearSessionCookie(reply);
    const ctx = auditContextFromRequest(request);
    await writeAuditEvent({
      userId: user.id,
      action: "auth.logout_all",
      targetKind: "user",
      targetId: user.id,
      ...ctx
    });
    return { ok: true };
  });

  app.get("/api/auth/sessions", async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    const currentHash = request.cookies.dm_session ? hashToken(request.cookies.dm_session) : "";
    return { sessions: await listSessionsForUser(user.id, currentHash) };
  });

  app.delete("/api/auth/sessions/:id", { config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    const { id } = sessionParamSchema.parse(request.params);
    const currentHash = request.cookies.dm_session ? hashToken(request.cookies.dm_session) : "";
    const result = await revokeSessionForUser(id, user.id, currentHash);
    if (!result.revoked) {
      return sendApiError(reply, 404, "NOT_FOUND", "Session not found");
    }
    if (result.wasCurrent) clearSessionCookie(reply);
    const ctx = auditContextFromRequest(request);
    await writeAuditEvent({
      userId: user.id,
      action: "auth.session.revoke",
      targetKind: "session",
      targetId: id,
      ...ctx
    });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = await readSession(request);
    if (!user) {
      return sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    }
    return { user };
  });
}
