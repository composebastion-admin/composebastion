import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const strongPassword = "Very-Secure-Pass1";

describe.skipIf(!integrationEnabled)("backup schedule API integration", () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let hostId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
    await pool.query("DELETE FROM backup_schedules");
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
        name: "Backup Host",
        hostname: "10.0.0.20",
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

  it("creates, lists, and deletes backup schedules", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/backup-schedules",
      headers: { cookie: sessionCookie },
      payload: {
        hostId,
        volumeName: "data",
        intervalMs: 3_600_000
      }
    });
    expect(created.statusCode).toBe(200);
    const scheduleId = created.json().schedule.id as string;

    const listed = await app.inject({
      method: "GET",
      url: "/api/backup-schedules",
      headers: { cookie: sessionCookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().schedules.some((row: { id: string }) => row.id === scheduleId)).toBe(true);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/backup-schedules/${scheduleId}`,
      headers: { cookie: sessionCookie }
    });
    expect(removed.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/backup-schedules",
      headers: { cookie: sessionCookie }
    });
    expect(after.json().schedules.some((row: { id: string }) => row.id === scheduleId)).toBe(false);
  });
});
