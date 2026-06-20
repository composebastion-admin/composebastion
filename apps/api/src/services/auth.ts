import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { v4 as uuid } from "uuid";
import type { AdminUser } from "@composebastion/shared";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { sendApiError } from "./apiError.js";
import { mapAdmin } from "./mappers.js";

const SESSION_COOKIE = "cb_session";
const SESSION_DAYS = 7;

type SessionContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function adminCount() {
  const result = await query<{ count: string }>("SELECT count(*) FROM admin_users");
  return Number(result.rows[0]?.count ?? 0);
}

export async function createAdmin(input: { email?: string; username?: string; password: string; name?: string }) {
  if ((await adminCount()) > 0) {
    throw new Error("Initial admin already exists");
  }

  const username = input.username?.trim().toLowerCase() || null;
  const email = input.email?.trim().toLowerCase() || (username ? `${username}@local.composebastion` : null);
  if (!email) throw new Error("Username or email is required");

  const passwordHash = await bcrypt.hash(input.password, 12);
  const result = await query(
    `INSERT INTO admin_users (id, name, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'owner')
     RETURNING id, name, username, email, role, is_active, created_at`,
    [uuid(), input.name ?? null, username, email, passwordHash]
  );
  return mapAdmin(result.rows[0]);
}

export async function verifyAdmin(identifier: string, password: string) {
  const normalized = identifier.trim().toLowerCase();
  const result = await query<any>(
    "SELECT * FROM admin_users WHERE is_active = true AND (lower(email) = $1 OR lower(username) = $1)",
    [normalized]
  );
  const row = result.rows[0];
  if (!row) return null;
  const valid = await bcrypt.compare(password, row.password_hash);
  return valid ? mapAdmin(row) : null;
}

function mapSession(row: any) {
  return {
    id: row.id,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    current: Boolean(row.current)
  };
}

export async function createSession(userId: string, context: SessionContext = {}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [uuid(), userId, hashToken(token), expiresAt, context.ipAddress ?? null, context.userAgent ?? null]
  );
  return { token, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.SECURE_COOKIES,
    expires: expiresAt
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function readSession(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashToken(token);

  const result = await query(
    `SELECT admin_users.id, admin_users.name, admin_users.username, admin_users.email, admin_users.role,
            admin_users.is_active, admin_users.last_login_at, admin_users.created_at
     FROM sessions
     JOIN admin_users ON admin_users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > now() AND admin_users.is_active = true`,
    [tokenHash]
  );
  if (!result.rows[0]) return null;
  await query(
    "UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')",
    [tokenHash]
  );
  return mapAdmin(result.rows[0]);
}

export async function destroySession(token?: string) {
  if (!token) return;
  await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function destroyAllSessionsForUser(userId: string) {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export async function listSessionsForUser(userId: string, currentTokenHash: string) {
  const result = await query(
    `SELECT id, ip_address, user_agent, created_at, last_seen_at, expires_at, (token_hash = $2) AS current
     FROM sessions
     WHERE user_id = $1 AND expires_at > now()
     ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
    [userId, currentTokenHash]
  );
  return result.rows.map(mapSession);
}

export async function revokeSessionForUser(sessionId: string, userId: string, currentTokenHash = "") {
  const result = await query<{ token_hash: string }>(
    "DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash",
    [sessionId, userId]
  );
  const tokenHash = result.rows[0]?.token_hash;
  return {
    revoked: Boolean(tokenHash),
    wasCurrent: Boolean(tokenHash && tokenHash === currentTokenHash)
  };
}

export async function deleteExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at < now()");
}

export async function touchLastLogin(userId: string) {
  await query("UPDATE admin_users SET last_login_at = now() WHERE id = $1", [userId]);
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = await readSession(request);
  if (!user) {
    sendApiError(reply, 401, "AUTH_REQUIRED", "Authentication required");
    return;
  }
  request.user = user;
}

export function requireRole(roles: AdminUser["role"][]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!request.user || !roles.includes(request.user.role)) {
      sendApiError(reply, 403, "FORBIDDEN", "Insufficient permissions");
    }
  };
}
