import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("host API integration", () => {
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");
    await pool.query("DELETE FROM docker_hosts");

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

  it("rejects duplicate hosts with 409", async () => {
    const payload = {
      name: "Prod",
      hostname: "10.0.0.10",
      port: 22,
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      sshPassword: "not-real",
      dockerSocketPath: "/var/run/docker.sock"
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: sessionCookie },
      payload
    });
    expect(first.statusCode).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: sessionCookie },
      payload: { ...payload, name: "Prod Clone" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("CONFLICT");
  });
});
