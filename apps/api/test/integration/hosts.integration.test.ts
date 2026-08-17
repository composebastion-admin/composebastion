import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    await pool.query("DELETE FROM operation_jobs");
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

  beforeEach(async () => {
    await pool.query("DELETE FROM operation_jobs");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM operation_jobs");
    await pool.query("DELETE FROM docker_hosts");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");
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

  it("serializes concurrent partial updates without losing either patch", async () => {
    const hostResult = await pool.query(
      "SELECT id FROM docker_hosts WHERE name = 'Prod' AND deleted_at IS NULL"
    );
    const hostId = hostResult.rows[0]?.id as string;

    const [rename, retag] = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/hosts/${hostId}`,
        headers: { cookie: sessionCookie },
        payload: { name: "Production primary" }
      }),
      app.inject({
        method: "PUT",
        url: `/api/hosts/${hostId}`,
        headers: { cookie: sessionCookie },
        payload: { tags: ["critical", "primary"] }
      })
    ]);

    expect(rename.statusCode).toBe(200);
    expect(retag.statusCode).toBe(200);
    const persisted = await pool.query(
      "SELECT name, tags FROM docker_hosts WHERE id = $1",
      [hostId]
    );
    expect(persisted.rows[0]).toMatchObject({
      name: "Production primary",
      tags: ["critical", "primary"]
    });
  });

  it("allows only one of two concurrent creates for the same connection", async () => {
    const connection = {
      hostname: "10.0.0.20",
      port: 22,
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      sshPassword: "not-real",
      dockerSocketPath: "/var/run/docker.sock"
    };

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/hosts",
        headers: { cookie: sessionCookie },
        payload: { ...connection, name: "Concurrent A" }
      }),
      app.inject({
        method: "POST",
        url: "/api/hosts",
        headers: { cookie: sessionCookie },
        payload: { ...connection, name: "Concurrent B" }
      })
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const count = await pool.query(
      `SELECT count(*)::int AS count
       FROM docker_hosts
       WHERE hostname = $1 AND username = $2 AND port = $3 AND deleted_at IS NULL`,
      [connection.hostname, connection.username, connection.port]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("rejects restoring a deleted host after its identity was reused", async () => {
    const original = await pool.query(
      "SELECT id FROM docker_hosts WHERE name = 'Production primary' AND deleted_at IS NULL"
    );
    const originalId = original.rows[0]?.id as string;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/hosts/${originalId}`,
      headers: { cookie: sessionCookie }
    });
    expect(deleted.statusCode).toBe(200);

    const replacement = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: sessionCookie },
      payload: {
        name: "Replacement primary",
        hostname: "10.0.0.10",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        sshPassword: "not-real",
        dockerSocketPath: "/var/run/docker.sock"
      }
    });
    expect(replacement.statusCode).toBe(200);

    const restored = await app.inject({
      method: "POST",
      url: `/api/hosts/${originalId}/restore`,
      headers: { cookie: sessionCookie }
    });
    expect(restored.statusCode).toBe(409);
    expect(restored.json()).toMatchObject({
      code: "CONFLICT",
      error: expect.stringContaining("same name or connection")
    });
  });
});
