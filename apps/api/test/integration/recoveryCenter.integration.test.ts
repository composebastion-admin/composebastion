import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("recovery center API integration", () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let hostId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM recovery_artifacts");
    await pool.query("DELETE FROM recovery_points");
    await pool.query("DELETE FROM recovery_schedules");
    await pool.query("DELETE FROM migration_runs");
    await pool.query("DELETE FROM backup_targets");
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
        name: "Recovery Host",
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

  it("creates backup targets and recovery points", async () => {
    const target = await app.inject({
      method: "POST",
      url: "/api/recovery/targets",
      headers: { cookie: sessionCookie },
      payload: { name: "Local vault", kind: "local" }
    });
    expect(target.statusCode).toBe(200);
    const targetId = target.json().target.id as string;

    const stack = await pool.query(
      `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'deployed')
       RETURNING id, project_name`,
      [
        "00000000-0000-4000-8000-000000000099",
        hostId,
        "Demo App",
        "demoapp",
        "services:\n  web:\n    image: nginx:alpine\n",
        "FOO=bar\n"
      ]
    );

    const point = await app.inject({
      method: "POST",
      url: "/api/recovery/points",
      headers: { cookie: sessionCookie },
      payload: {
        hostId,
        name: "Before upgrade",
        backupTargetId: targetId,
        appIdentity: {
          kind: "stack",
          stackId: stack.rows[0].id,
          projectName: stack.rows[0].project_name
        }
      }
    });
    expect(point.statusCode).toBe(200);
    const pointId = point.json().point.id as string;
    expect(point.json().job.type).toBe("recovery.create");

    const listed = await app.inject({
      method: "GET",
      url: `/api/recovery/points?hostId=${hostId}`,
      headers: { cookie: sessionCookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().points.some((row: { id: string }) => row.id === pointId)).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/api/recovery/points/${pointId}`,
      headers: { cookie: sessionCookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().point.artifacts.length).toBeGreaterThan(0);
  });

  it("creates migration plans and schedules", async () => {
    const plan = await app.inject({
      method: "POST",
      url: "/api/recovery/migrations/plan",
      headers: { cookie: sessionCookie },
      payload: {
        sourceHostId: hostId,
        targetHostId: hostId,
        sourceAppIdentity: {
          kind: "compose",
          projectName: "demoapp"
        }
      }
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().run.mode).toBe("plan");
    expect(plan.json().run.plan.steps.length).toBeGreaterThan(0);

    const schedule = await app.inject({
      method: "POST",
      url: "/api/recovery/schedules",
      headers: { cookie: sessionCookie },
      payload: {
        hostId,
        name: "Nightly",
        intervalMs: 3_600_000,
        appIdentity: { kind: "compose", projectName: "demoapp" }
      }
    });
    expect(schedule.statusCode).toBe(200);

    const schedules = await app.inject({
      method: "GET",
      url: "/api/recovery/schedules",
      headers: { cookie: sessionCookie }
    });
    expect(schedules.statusCode).toBe(200);
    expect(schedules.json().schedules.length).toBeGreaterThan(0);
  }, 20_000);
});
