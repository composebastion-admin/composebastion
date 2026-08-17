import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("login lockout integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM login_attempts");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");

    await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: strongPassword }
    });
  });

  beforeEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS login_audit_reject ON audit_events");
    await pool.query("DROP FUNCTION IF EXISTS login_audit_reject_fn()");
    await pool.query("DELETE FROM login_attempts");
    await pool.query(
      "DELETE FROM audit_events WHERE action IN ('auth.login_failed', 'auth.lockout')"
    );
  });

  afterAll(async () => {
    await app.close();
  });

  function login(password: string, remoteAddress: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress,
      payload: { identifier: "admin", password }
    });
  }

  it("locks the attacking IP after repeated failures", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login("wrong-password", "203.0.113.10");
    }

    const locked = await login(strongPassword, "203.0.113.10");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("ACCOUNT_LOCKED");

    const audits = await pool.query<{
      action: string;
      target_id: string | null;
      details: Record<string, unknown>;
      ip_address: string | null;
    }>(
      `SELECT action, target_id, details, ip_address
       FROM audit_events
       WHERE action IN ('auth.login_failed', 'auth.lockout')
       ORDER BY created_at ASC`
    );
    expect(audits.rows.filter((row) => row.action === "auth.login_failed")).toHaveLength(10);
    expect(audits.rows.filter((row) => row.action === "auth.lockout")).toHaveLength(1);
    expect(audits.rows.every((row) => row.target_id === null)).toBe(true);
    expect(audits.rows.every((row) => row.ip_address === "203.0.113.10")).toBe(true);
    expect(JSON.stringify(audits.rows)).not.toContain("admin");
    expect(JSON.stringify(audits.rows)).not.toContain("wrong-password");
  });

  it("does not let one attacker IP lock the account for a legitimate IP", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login("wrong-password", "203.0.113.20");
    }

    const allowed = await login(strongPassword, "203.0.113.21");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().user.username).toBe("admin");
  });

  it("locks one attacking IP across credential-stuffing attempts for different identifiers", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "203.0.113.22",
        payload: {
          identifier: `unknown-${attempt}@example.test`,
          password: "wrong-password"
        }
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await login(strongPassword, "203.0.113.22");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("ACCOUNT_LOCKED");
  });

  it("rolls back the failed-attempt counter when its required audit insert fails", async () => {
    await pool.query(`
      CREATE FUNCTION login_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'auth.login_failed' THEN
          RAISE EXCEPTION 'intentional login audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER login_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION login_audit_reject_fn()
    `);

    try {
      const response = await login("wrong-password", "203.0.113.30");
      expect(response.statusCode).toBe(500);

      const attempts = await pool.query(
        "SELECT id FROM login_attempts WHERE ip_address = $1",
        ["203.0.113.30"]
      );
      expect(attempts.rowCount).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS login_audit_reject ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS login_audit_reject_fn()");
    }
  });
});
