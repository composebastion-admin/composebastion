import { randomUUID } from "node:crypto";
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
    await pool.query("DROP TRIGGER IF EXISTS compose_create_audit_reject ON audit_events");
    await pool.query("DROP FUNCTION IF EXISTS compose_create_audit_reject_fn()");
    await app.close();
  });

  it("rolls back stack and initial version when create audit persistence fails", async () => {
    await pool.query(`
      CREATE FUNCTION compose_create_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'compose.create' THEN
          RAISE EXCEPTION 'intentional compose create audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER compose_create_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION compose_create_audit_reject_fn()
    `);
    const projectName = `audit-${randomUUID().slice(0, 8)}`;

    try {
      const created = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/compose`,
        headers: { cookie: sessionCookie },
        payload: {
          name: "Atomic create",
          projectName,
          composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
          env: ""
        }
      });
      expect(created.statusCode).toBe(500);

      const stacks = await pool.query(
        "SELECT id FROM compose_stacks WHERE host_id = $1 AND project_name = $2",
        [hostId, projectName]
      );
      expect(stacks.rowCount).toBe(0);
      const versions = await pool.query(
        `SELECT versions.id
         FROM compose_stack_versions AS versions
         JOIN compose_stacks AS stacks ON stacks.id = versions.stack_id
         WHERE stacks.host_id = $1 AND stacks.project_name = $2`,
        [hostId, projectName]
      );
      expect(versions.rowCount).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS compose_create_audit_reject ON audit_events");
      await pool.query("DROP FUNCTION IF EXISTS compose_create_audit_reject_fn()");
    }
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

  it("returns 409 and leaves v2 active when a host-file stack requests rollback to v1", async () => {
    await pool.query(
      `UPDATE compose_stacks
       SET source_type = 'host_files',
           source_working_dir = '/srv/apps/demo-stack',
           source_compose_path = 'compose.yaml'
       WHERE id = $1`,
      [stackId]
    );
    const before = await pool.query<any>(
      `SELECT compose_yaml, current_version_id,
              (SELECT count(*)::int FROM compose_stack_versions WHERE stack_id = $1) AS version_count
       FROM compose_stacks
       WHERE id = $1`,
      [stackId]
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/compose/${stackId}/rollback`,
      headers: { cookie: sessionCookie },
      payload: { versionId: firstVersionId }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "CONFLICT",
      error: expect.stringContaining("cannot safely overwrite source files")
    });
    const after = await pool.query<any>(
      `SELECT compose_yaml, current_version_id,
              (SELECT count(*)::int FROM compose_stack_versions WHERE stack_id = $1) AS version_count
       FROM compose_stacks
       WHERE id = $1`,
      [stackId]
    );
    const jobs = await pool.query(
      "SELECT id FROM operation_jobs WHERE host_id = $1 AND payload->>'stackId' = $2",
      [hostId, stackId]
    );
    expect(after.rows[0]?.compose_yaml).toContain("nginx:1.28");
    expect(after.rows[0]?.compose_yaml).toBe(before.rows[0]?.compose_yaml);
    expect(after.rows[0]?.current_version_id).toBe(before.rows[0]?.current_version_id);
    expect(after.rows[0]?.version_count).toBe(before.rows[0]?.version_count);
    expect(jobs.rowCount).toBe(0);
  });
});
