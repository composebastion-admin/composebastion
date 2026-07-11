import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("user invariant integration", () => {
  let app: FastifyInstance;
  let ownerCookie = "";
  let ownerId = "";

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE admin_users RESTART IDENTITY CASCADE");
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "owner", password: strongPassword }
    });
    expect(setup.statusCode).toBe(200);
    ownerCookie = String(setup.headers["set-cookie"] ?? "");
    ownerId = setup.json().user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(username: string, role: "admin" | "operator" | "viewer" = "admin") {
    const response = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: ownerCookie },
      payload: { username, email: `${username}@example.test`, password: strongPassword, role }
    });
    expect(response.statusCode).toBe(200);
    return response.json().user;
  }

  async function login(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: username, password: strongPassword }
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"] ?? "");
  }

  it("blocks self role changes, self-disable, and self-delete", async () => {
    for (const request of [
      { method: "PUT", payload: { role: "admin" } },
      { method: "PUT", payload: { isActive: false } },
      { method: "DELETE", payload: undefined }
    ]) {
      const response = await app.inject({
        method: request.method,
        url: `/api/users/${ownerId}`,
        headers: { cookie: ownerCookie },
        payload: request.payload
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it("revokes every session when a password changes", async () => {
    const secondSession = await login("owner");
    const changed = await app.inject({
      method: "PUT",
      url: `/api/users/${ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { password: "Different-Secure-Pass2" }
    });
    expect(changed.statusCode).toBe(200);

    for (const cookie of [ownerCookie, secondSession]) {
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.statusCode).toBe(401);
    }
  });

  it("serializes concurrent attempts to disable both active owners", async () => {
    const secondOwner = await createUser("owner-two");
    const promoted = await app.inject({
      method: "PUT",
      url: `/api/users/${secondOwner.id}`,
      headers: { cookie: ownerCookie },
      payload: { role: "owner" }
    });
    expect(promoted.statusCode).toBe(200);

    await createUser("admin-actor");
    const adminCookie = await login("admin-actor");
    const responses = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/users/${ownerId}`,
        headers: { cookie: adminCookie },
        payload: { isActive: false }
      }),
      app.inject({
        method: "PUT",
        url: `/api/users/${secondOwner.id}`,
        headers: { cookie: adminCookie },
        payload: { isActive: false }
      })
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const activeOwners = await pool.query("SELECT id FROM admin_users WHERE role = 'owner' AND is_active = true");
    expect(activeOwners.rowCount).toBe(1);
  });
});
