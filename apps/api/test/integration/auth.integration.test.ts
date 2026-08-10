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
    await pool.query("DROP TRIGGER IF EXISTS auth_atomicity_audit_reject ON audit_events");
    await pool.query("DROP FUNCTION IF EXISTS auth_atomicity_audit_reject_fn()");
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
      remoteAddress: "192.0.2.1",
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

  it("allows exactly one owner when setup requests race", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/setup",
        remoteAddress: "192.0.2.10",
        payload: { username: "owner-one", password: strongPassword }
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/setup",
        remoteAddress: "192.0.2.10",
        payload: { username: "owner-two", password: strongPassword }
      })
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const owners = await pool.query("SELECT id FROM admin_users WHERE role = 'owner' AND is_active = true");
    expect(owners.rowCount).toBe(1);
    const sessions = await pool.query("SELECT id FROM sessions");
    expect(sessions.rowCount).toBe(1);
    const setupAudits = await pool.query(
      "SELECT id FROM audit_events WHERE action = 'auth.setup'"
    );
    expect(setupAudits.rowCount).toBe(1);
  });

  it("rolls back owner, demo data, audit, and session when demo setup fails", async () => {
    const conflictHostId = randomUUID();
    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, username, ssh_key_encrypted
       )
       VALUES ($1, 'Demo Production Node', $2, 'conflict', 'not-a-real-key')`,
      [conflictHostId, `${randomUUID()}.invalid`]
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        remoteAddress: "192.0.2.20",
        payload: {
          username: "atomic-owner",
          password: strongPassword,
          includeDemoData: true
        }
      });
      expect(response.statusCode).toBe(409);

      const [users, sessions, setupAudits, demoHosts] = await Promise.all([
        pool.query("SELECT id FROM admin_users"),
        pool.query("SELECT id FROM sessions"),
        pool.query("SELECT id FROM audit_events WHERE action = 'auth.setup'"),
        pool.query(
          "SELECT id FROM docker_hosts WHERE tags @> ARRAY['demo']::text[]"
        )
      ]);
      expect(users.rowCount).toBe(0);
      expect(sessions.rowCount).toBe(0);
      expect(setupAudits.rowCount).toBe(0);
      expect(demoHosts.rowCount).toBe(0);
    } finally {
      await pool.query("DELETE FROM docker_hosts WHERE id = $1", [conflictHostId]);
    }
  });

  it("rolls back first-owner setup when its required audit insert fails", async () => {
    await pool.query(`
      CREATE FUNCTION auth_atomicity_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'auth.setup' THEN
          RAISE EXCEPTION 'intentional auth setup audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER auth_atomicity_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION auth_atomicity_audit_reject_fn()
    `);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        remoteAddress: "192.0.2.30",
        payload: { username: "atomic-owner", password: strongPassword }
      });
      expect(response.statusCode).toBe(500);

      const [users, sessions] = await Promise.all([
        pool.query("SELECT id FROM admin_users"),
        pool.query("SELECT id FROM sessions")
      ]);
      expect(users.rowCount).toBe(0);
      expect(sessions.rowCount).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS auth_atomicity_audit_reject ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS auth_atomicity_audit_reject_fn()");
    }
  });

  it("rolls back login session and last-login timestamp when login audit fails", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "192.0.2.40",
      payload: { username: "atomic-owner", password: strongPassword }
    });
    expect(setup.statusCode).toBe(200);
    const userId = setup.json().user.id as string;
    const baseline = new Date("2026-01-02T03:04:05.000Z");
    await pool.query("DELETE FROM sessions");
    await pool.query(
      "UPDATE admin_users SET last_login_at = $2 WHERE id = $1",
      [userId, baseline]
    );
    await pool.query(`
      CREATE FUNCTION auth_atomicity_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'auth.login' THEN
          RAISE EXCEPTION 'intentional auth login audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER auth_atomicity_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION auth_atomicity_audit_reject_fn()
    `);

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: "atomic-owner", password: strongPassword }
      });
      expect(login.statusCode).toBe(500);

      const [sessions, saved] = await Promise.all([
        pool.query("SELECT id FROM sessions WHERE user_id = $1", [userId]),
        pool.query<{ last_login_at: Date }>(
          "SELECT last_login_at FROM admin_users WHERE id = $1",
          [userId]
        )
      ]);
      expect(sessions.rowCount).toBe(0);
      expect(saved.rows[0]?.last_login_at.toISOString()).toBe(
        baseline.toISOString()
      );
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS auth_atomicity_audit_reject ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS auth_atomicity_audit_reject_fn()");
    }
  });

  it("does not return session metadata when its read audit fails", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "192.0.2.70",
      headers: { "user-agent": "Sensitive Session Agent" },
      payload: { username: "session-owner", password: strongPassword }
    });
    expect(setup.statusCode).toBe(200);
    const cookie = firstSetCookie(setup);
    await pool.query(`
      CREATE FUNCTION auth_atomicity_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'auth.sessions_read' THEN
          RAISE EXCEPTION 'intentional session read audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER auth_atomicity_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION auth_atomicity_audit_reject_fn()
    `);

    try {
      const listed = await app.inject({
        method: "GET",
        url: "/api/auth/sessions",
        headers: { cookie }
      });
      expect(listed.statusCode).toBe(500);
      expect(listed.body).not.toContain("Sensitive Session Agent");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS auth_atomicity_audit_reject ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS auth_atomicity_audit_reject_fn()");
    }
  });

  it("rejects weak setup passwords", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "192.0.2.50",
      payload: { username: "admin2", password: "short" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("lists and revokes active sessions without exposing token material", async () => {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      remoteAddress: "192.0.2.60",
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
