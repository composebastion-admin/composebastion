import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("catalog API integration", () => {
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: strongPassword }
    });
    sessionCookie = setup.headers["set-cookie"] as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists built-in catalog templates", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/catalog/templates",
      headers: { cookie: sessionCookie }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.templates.length).toBeGreaterThanOrEqual(8);
    expect(body.templates.some((template: { id: string }) => template.id === "nginx")).toBe(true);
  });
});
