import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("stack versions API integration", () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let hostId: string;
  let stackId: string;
  let firstVersionId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM compose_stack_versions");
    await pool.query("DELETE FROM compose_stacks");
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM admin_users");
    await pool.query("DELETE FROM docker_hosts");

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: strongPassword }
    });
    sessionCookie = setup.headers["set-cookie"] as string;

    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      headers: { cookie: sessionCookie },
      payload: {
        name: "Compose Host",
        hostname: "10.0.0.30",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        sshPassword: "not-real",
        dockerSocketPath: "/var/run/docker.sock"
      }
    });
    hostId = host.json().host.id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a version on stack create and lists versions after update", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/hosts/${hostId}/compose`,
      headers: { cookie: sessionCookie },
      payload: {
        name: "Demo Stack",
        projectName: "demo-stack",
        composeYaml: "services:\n  app:\n    image: nginx:1.27\n",
        env: "FOO=bar"
      }
    });
    expect(created.statusCode).toBe(200);
    stackId = created.json().stack.id as string;

    const listed = await app.inject({
      method: "GET",
      url: `/api/compose/${stackId}/versions`,
      headers: { cookie: sessionCookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().versions).toHaveLength(1);
    firstVersionId = listed.json().versions[0].id as string;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/compose/${stackId}`,
      headers: { cookie: sessionCookie },
      payload: { composeYaml: "services:\n  app:\n    image: nginx:1.28\n" }
    });
    expect(updated.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/compose/${stackId}/versions`,
      headers: { cookie: sessionCookie }
    });
    expect(after.json().versions).toHaveLength(2);

    const diff = await app.inject({
      method: "GET",
      url: `/api/compose/${stackId}/versions/diff?from=${encodeURIComponent(firstVersionId)}&to=${encodeURIComponent(after.json().versions[0].id)}`,
      headers: { cookie: sessionCookie }
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().composeChanges.length).toBeGreaterThan(0);
  });
});
