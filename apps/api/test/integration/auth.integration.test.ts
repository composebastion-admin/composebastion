import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("auth API integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM audit_events");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");
  });

  afterAll(async () => {
    await app.close();
  });

  function firstSetCookie(response: Awaited<ReturnType<FastifyInstance["inject"]>>) {
    const cookie = response.headers["set-cookie"];
    return Array.isArray(cookie) ? cookie[0] ?? "" : String(cookie ?? "");
  }

  it("reports setup required on a fresh database", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/setup-state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ needsSetup: true });
  });

  it("creates the first admin and returns a session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: strongPassword }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.username).toBe("admin");
    expect(response.headers["set-cookie"]).toMatch(/cb_session=/);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: response.headers["set-cookie"] as string }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toContain("admin");
  });

  it("rejects weak setup passwords", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin2", password: "short" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("lists and revokes active sessions without exposing token material", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "user-agent": "Chrome Test Agent" },
      payload: { username: "admin", password: strongPassword }
    });
    expect(setup.statusCode).toBe(200);
    const setupCookie = firstSetCookie(setup);
    expect(setupCookie).toMatch(/cb_session=/);

    const setupSession = await pool.query(
      "SELECT id, token_hash, ip_address, user_agent, last_seen_at FROM sessions ORDER BY created_at ASC LIMIT 1"
    );
    expect(setupSession.rows[0]?.user_agent).toBe("Chrome Test Agent");
    expect(setupSession.rows[0]?.ip_address).toBeTruthy();
    expect(setupSession.rows[0]?.last_seen_at).toBeTruthy();

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "user-agent": "Firefox Test Agent" },
      payload: { identifier: "admin", password: strongPassword }
    });
    expect(login.statusCode).toBe(200);
    const loginCookie = firstSetCookie(login);
    expect(loginCookie).toMatch(/cb_session=/);

    const listed = await app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: loginCookie }
    });
    expect(listed.statusCode).toBe(200);
    const listBody = listed.json();
    expect(listBody.sessions).toHaveLength(2);
    expect(JSON.stringify(listBody)).not.toContain("token_hash");
    expect(JSON.stringify(listBody)).not.toContain(setupSession.rows[0]?.token_hash);
    expect(listBody.sessions.filter((session: any) => session.current)).toHaveLength(1);
    const current = listBody.sessions.find((session: any) => session.current);
    const other = listBody.sessions.find((session: any) => !session.current);
    expect(current.userAgent).toBe("Firefox Test Agent");
    expect(other.userAgent).toBe("Chrome Test Agent");
    for (const session of listBody.sessions) {
      expect(Object.keys(session).sort()).toEqual(["createdAt", "current", "expiresAt", "id", "ipAddress", "lastSeenAt", "userAgent"].sort());
    }

    const revokeOther = await app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${other.id}`,
      headers: { cookie: loginCookie, "user-agent": "Firefox Test Agent" }
    });
    expect(revokeOther.statusCode).toBe(200);
    expect(revokeOther.json()).toEqual({ ok: true });
    const audit = await pool.query(
      "SELECT action, target_kind, target_id, user_agent FROM audit_events WHERE action = 'auth.session.revoke' AND target_id = $1",
      [other.id]
    );
    expect(audit.rows).toMatchObject([{ action: "auth.session.revoke", target_kind: "session", target_id: other.id, user_agent: "Firefox Test Agent" }]);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: loginCookie }
    });
    expect(afterRevoke.statusCode).toBe(200);
    expect(afterRevoke.json().sessions.map((session: any) => session.id)).toEqual([current.id]);

    const otherUserId = randomUUID();
    const otherSessionId = randomUUID();
    await pool.query(
      "INSERT INTO admin_users (id, email, password_hash, role, is_active) VALUES ($1, $2, $3, 'viewer', true)",
      [otherUserId, `other-${randomUUID()}@example.com`, "not-a-real-login-hash"]
    );
    await pool.query(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
      [otherSessionId, otherUserId, `other-session-${randomUUID()}`]
    );
    const revokeOtherUser = await app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${otherSessionId}`,
      headers: { cookie: loginCookie }
    });
    expect(revokeOtherUser.statusCode).toBe(404);
    const otherStillExists = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [otherSessionId]);
    expect(otherStillExists.rowCount).toBe(1);

    const revokeMissing = await app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${randomUUID()}`,
      headers: { cookie: loginCookie }
    });
    expect(revokeMissing.statusCode).toBe(404);

    const revokeCurrent = await app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${current.id}`,
      headers: { cookie: loginCookie }
    });
    expect(revokeCurrent.statusCode).toBe(200);
    expect(firstSetCookie(revokeCurrent)).toMatch(/cb_session=/);

    const meAfterCurrentRevoke = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: loginCookie }
    });
    expect(meAfterCurrentRevoke.statusCode).toBe(401);
  });
});
