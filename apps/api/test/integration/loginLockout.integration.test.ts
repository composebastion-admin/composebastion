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
    await pool.query("DELETE FROM login_attempts");
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
  });

  it("does not let one attacker IP lock the account for a legitimate IP", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await login("wrong-password", "203.0.113.20");
    }

    const allowed = await login(strongPassword, "203.0.113.21");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().user.username).toBe("admin");
  });
});
