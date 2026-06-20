import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.DOCKERMENDER_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

type Role = "admin" | "operator" | "viewer";

describe.skipIf(!integrationEnabled)("RBAC API integration", () => {
  let app: FastifyInstance;
  let ownerCookie = "";
  const cookies = new Map<Role | "owner", string>();

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    cookies.clear();
    await pool.query("TRUNCATE TABLE admin_users, docker_hosts RESTART IDENTITY CASCADE");

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "owner", password: strongPassword }
    });
    expect(setup.statusCode).toBe(200);
    ownerCookie = firstSetCookie(setup);
    cookies.set("owner", ownerCookie);

    for (const role of ["admin", "operator", "viewer"] as Role[]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie: ownerCookie },
        payload: {
          name: role,
          username: role,
          email: `${role}@example.test`,
          password: strongPassword,
          role
        }
      });
      expect(created.statusCode, role).toBe(200);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { identifier: role, password: strongPassword }
      });
      expect(login.statusCode, role).toBe(200);
      cookies.set(role, firstSetCookie(login));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  function firstSetCookie(response: Awaited<ReturnType<FastifyInstance["inject"]>>) {
    const cookie = response.headers["set-cookie"];
    return Array.isArray(cookie) ? cookie[0] ?? "" : String(cookie ?? "");
  }

  async function requestAs(role: Role | "owner", method: string, url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { cookie: cookies.get(role) ?? "" },
      payload
    });
  }

  it("enforces representative read, operator, and admin-only permissions through real sessions", async () => {
    for (const url of ["/api/hosts", "/api/jobs", "/api/recovery/points", "/api/alerts/history"]) {
      const response = await requestAs("viewer", "GET", url);
      expect(response.statusCode, `viewer ${url}`).toBe(200);
    }

    for (const route of [
      { method: "GET", url: "/api/registries" },
      { method: "GET", url: "/api/audit" },
      { method: "GET", url: "/api/users" },
      { method: "POST", url: "/api/config/export", payload: { passphrase: "long-enough-passphrase" } },
      { method: "GET", url: "/api/hosts/11111111-1111-4111-8111-111111111111/files" },
      { method: "POST", url: "/api/jobs/22222222-2222-4222-8222-222222222222/cancel" }
    ]) {
      const response = await requestAs("viewer", route.method, route.url, route.payload);
      expect(response.statusCode, `viewer ${route.method} ${route.url}`).toBe(403);
    }

    expect((await requestAs("operator", "GET", "/api/registries")).statusCode).toBe(200);
    expect((await requestAs("operator", "GET", "/api/recovery/schedules")).statusCode).toBe(200);
    expect((await requestAs("operator", "GET", "/api/audit")).statusCode).toBe(403);
    expect((await requestAs("operator", "GET", "/api/users")).statusCode).toBe(403);
    expect((await requestAs("operator", "POST", "/api/config/export", { passphrase: "long-enough-passphrase" })).statusCode).toBe(403);

    expect((await requestAs("admin", "GET", "/api/audit")).statusCode).toBe(200);
    expect((await requestAs("admin", "GET", "/api/users")).statusCode).toBe(200);
    expect((await requestAs("owner", "GET", "/api/audit")).statusCode).toBe(200);
    expect((await requestAs("owner", "GET", "/api/users")).statusCode).toBe(200);
  });
});
