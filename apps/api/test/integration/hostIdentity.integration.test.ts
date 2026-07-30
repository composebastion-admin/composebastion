import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { seedDemoWorkspace } from "../../src/services/demo.js";
import {
  HOST_CREATE_LOCK_ID,
  lockHostIdentityScope
} from "../../src/services/hostIdentity.js";
import { createHost } from "../../src/services/hosts.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("host identity advisory lock integration", () => {
  let applicationMutationStarted = false;

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    if (!applicationMutationStarted) return;
    const demoHosts = await pool.query<{ id: string }>(
      `SELECT id
       FROM docker_hosts
       WHERE 'demo' = ANY(tags)
          OR lower(btrim(hostname)) = ANY($1::text[])`,
      [[
        "demo.composebastion.local",
        "demo.edge.composebastion.local",
        "demo.dr.composebastion.local"
      ]]
    );
    const hostIds = demoHosts.rows.map(({ id }) => id);
    if (hostIds.length) {
      await pool.query("DELETE FROM operation_jobs WHERE host_id = ANY($1::uuid[])", [hostIds]);
      await pool.query("DELETE FROM audit_events WHERE host_id = ANY($1::uuid[]) OR action = 'demo.seed'", [hostIds]);
      await pool.query(
        "DELETE FROM github_repositories WHERE default_host_id = ANY($1::uuid[]) OR name LIKE 'Demo %'",
        [hostIds]
      );
      await pool.query("DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])", [hostIds]);
    }
    await pool.query(
      "DELETE FROM notification_channels WHERE config->>'demo' = 'true' OR name LIKE 'Demo %'"
    );
    await pool.query(
      "DELETE FROM recovery_artifacts WHERE backup_target_id IN (SELECT id FROM backup_targets WHERE config->>'demo' = 'true' OR name LIKE 'Demo %')"
    );
    await pool.query("DELETE FROM backup_targets WHERE config->>'demo' = 'true' OR name LIKE 'Demo %'");
    await pool.query("DELETE FROM registries WHERE name LIKE 'Demo %'");
    await pool.query("DELETE FROM custom_catalog_templates WHERE id LIKE 'demo-%'");
    await pool.query(
      `DELETE FROM favorite_images
       WHERE image = ANY($1::text[])`,
      [[
        "nginx:1.27-alpine",
        "postgres:16-alpine",
        "redis:7-alpine",
        "grafana/grafana:11.5.2",
        "prom/prometheus:v2.54.1",
        "ghcr.io/open-webui/open-webui:main",
        "registry:2",
        "caddy:2-alpine"
      ]]
    );
    applicationMutationStarted = false;
  });

  async function waitingLockCount() {
    const locks = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid::bigint = ($1::bigint >> 32)
         AND objid::bigint = ($1::bigint & 4294967295)
         AND NOT granted`,
      [HOST_CREATE_LOCK_ID]
    );
    return Number(locks.rows[0]?.waiting ?? 0);
  }

  async function waitForLockWaiters(minimum: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await waitingLockCount() >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${minimum} host identity lock waiter(s)`);
  }

  it("serializes two real PostgreSQL transactions on the shared identity key", async () => {
    const holder = await pool.connect();
    const waiter = await pool.connect();
    let holderOpen = false;
    let waiterOpen = false;
    let waitingLock: Promise<void> | undefined;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      await waiter.query("BEGIN");
      waiterOpen = true;
      await lockHostIdentityScope(holder);
      waitingLock = lockHostIdentityScope(waiter);

      await waitForLockWaiters(1);

      await holder.query("COMMIT");
      holderOpen = false;
      await waitingLock;
      await waiter.query("COMMIT");
      waiterOpen = false;
    } finally {
      if (holderOpen) {
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      if (waitingLock) {
        await waitingLock.catch(() => undefined);
      }
      if (waiterOpen) {
        await waiter.query("ROLLBACK").catch(() => undefined);
      }
      holder.release();
      waiter.release();
    }
  });

  it("serializes production create and demo seed with atomic normalized conflicts", async () => {
    applicationMutationStarted = true;
    const holder = await pool.connect();
    let holderOpen = false;
    let createPromise: ReturnType<typeof createHost> | undefined;
    let demoPromise: ReturnType<typeof seedDemoWorkspace> | undefined;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      await lockHostIdentityScope(holder);

      createPromise = createHost({
        name: "Concurrent precursor",
        hostname: "  DEMO.COMPOSEBASTION.LOCAL  ",
        port: 22,
        username: "demo",
        connectionMode: "ssh",
        sshAuthType: "password",
        sshPassword: "test-only-password",
        dockerSocketPath: "/var/run/docker.sock"
      });
      await waitForLockWaiters(1);

      demoPromise = seedDemoWorkspace();
      await waitForLockWaiters(2);
      await expect(pool.query(
        `SELECT count(*)::int AS count
         FROM docker_hosts
         WHERE lower(btrim(hostname)) = lower(btrim($1))
           AND username = $2
           AND port = $3`,
        ["demo.composebastion.local", "demo", 22]
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });

      await holder.query("COMMIT");
      holderOpen = false;
      const created = await createPromise;
      await expect(demoPromise).rejects.toMatchObject({ statusCode: 409 });

      const precursor = await pool.query<{ id: string; name: string; tags: string[] }>(
        `SELECT id, name, tags
         FROM docker_hosts
         WHERE lower(btrim(hostname)) = lower(btrim($1))
           AND username = $2
           AND port = $3`,
        ["demo.composebastion.local", "demo", 22]
      );
      expect(precursor.rows).toEqual([expect.objectContaining({
        id: created.id,
        name: "Concurrent precursor",
        tags: []
      })]);

      await pool.query("DELETE FROM docker_hosts WHERE id = $1", [created.id]);
      const seeded = await seedDemoWorkspace();
      expect(seeded.host).toMatchObject({
        name: "Demo Production Node",
        tags: expect.arrayContaining(["demo"])
      });
      await expect(createHost({
        name: "  demo production NODE ",
        hostname: "other.example.test",
        port: 2222,
        username: "other",
        connectionMode: "ssh",
        sshAuthType: "password",
        sshPassword: "test-only-password",
        dockerSocketPath: "/var/run/docker.sock"
      })).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      if (holderOpen) {
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      await Promise.allSettled([
        ...(createPromise ? [createPromise] : []),
        ...(demoPromise ? [demoPromise] : [])
      ]);
      holder.release();
    }
  });
});
