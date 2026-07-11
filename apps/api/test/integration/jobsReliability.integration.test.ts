import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { env } from "../../src/config/env.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { checkDockerHost } from "../../src/services/docker.js";
import {
  assertJobLeaseActive,
  claimNextJob,
  completeJob,
  failJob,
  getWorkerStatus,
  JobLeaseLostError,
  markWorkerDraining,
  markWorkerStopped,
  recoverExpiredJobs,
  registerWorkerInstance,
  renewJobLease,
  retryJob,
  updateJobProgress,
  withActiveJobLeaseTransaction
} from "../../src/services/jobs.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("worker reliability integration", () => {
  let app: FastifyInstance;
  const testHostIds: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    app = await buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM operation_jobs");
    await pool.query("DELETE FROM worker_instances");
  });

  afterEach(async () => {
    await pool.query("DELETE FROM operation_jobs");
    if (testHostIds.length) {
      await pool.query("DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])", [testHostIds.splice(0)]);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertHost(options: { demo?: boolean } = {}) {
    const id = randomUUID();
    testHostIds.push(id);
    await pool.query(
      `INSERT INTO docker_hosts (id, name, hostname, port, username, docker_socket_path, connection_mode, ssh_auth_type, tags)
       VALUES ($1, $2, '127.0.0.1', 22, 'docker', '/var/run/docker.sock', 'ssh', 'key', $3)`,
      [id, `Reliability ${id}`, options.demo ? ["demo"] : []]
    );
    return id;
  }

  async function insertJob(type: string, overrides: {
    status?: string;
    attemptCount?: number;
    expired?: boolean;
    hostId?: string | null;
    payload?: Record<string, unknown>;
    legacyStartedAt?: Date;
  } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO operation_jobs
         (id, type, status, host_id, payload, lease_owner, lease_expires_at, attempt_count, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        type,
        overrides.status ?? "queued",
        overrides.hostId ?? null,
        overrides.payload ?? {},
        overrides.status === "running" && !overrides.legacyStartedAt ? randomUUID() : null,
        overrides.status === "running"
          ? overrides.legacyStartedAt ? null : new Date(Date.now() + (overrides.expired ? -60_000 : 60_000))
          : null,
        overrides.attemptCount ?? 0,
        overrides.legacyStartedAt ?? (overrides.status === "running" ? new Date() : null)
      ]
    );
    return id;
  }

  it("tracks active, draining, and stopped worker availability", async () => {
    const workerId = randomUUID();
    await registerWorkerInstance({ id: workerId, version: "1.0.7-rc.1", hostname: "integration-worker" });
    await expect(getWorkerStatus()).resolves.toMatchObject({ available: true, activeWorkers: 1, state: "active" });

    await markWorkerDraining(workerId);
    await expect(getWorkerStatus()).resolves.toMatchObject({ available: false, activeWorkers: 0, state: "draining" });

    await markWorkerStopped(workerId);
    await expect(getWorkerStatus()).resolves.toMatchObject({ available: false, activeWorkers: 0, state: "absent" });
  });

  it("makes readiness fail closed when the worker heartbeat is absent", async () => {
    const absent = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(absent.statusCode).toBe(503);
    expect(absent.json().checks.worker).toMatchObject({ ok: false, available: false, state: "absent" });

    await registerWorkerInstance({ id: randomUUID(), version: "1.0.7-rc.1", hostname: "integration-worker" });
    const active = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(active.statusCode).toBe(200);
    expect(active.json().checks.worker).toMatchObject({ ok: true, available: true, state: "active" });
  });

  it("keeps Redis diagnostic and non-required when PostgreSQL and the worker are healthy", async () => {
    await registerWorkerInstance({ id: randomUUID(), version: "1.0.7-rc.1", hostname: "integration-worker" });
    const originalRedisUrl = env.REDIS_URL;
    env.REDIS_URL = "redis://127.0.0.1:1";
    try {
      const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        ok: true,
        checks: {
          database: { ok: true, required: true },
          redis: { ok: false, required: false },
          backups: { required: false },
          worker: { ok: true, required: true, available: true }
        }
      });

      const diagnostic = await app.inject({ method: "GET", url: "/api/health/redis" });
      expect(diagnostic.statusCode).toBe(503);
      expect(diagnostic.json()).toMatchObject({ ok: false, configured: true });
    } finally {
      env.REDIS_URL = originalRedisUrl;
    }
  });

  it("claims concurrently without duplication and fences terminal writes", async () => {
    await insertJob("host.check");
    await insertJob("host.sync");
    const workerA = randomUUID();
    const workerB = randomUUID();

    const [jobA, jobB] = await Promise.all([claimNextJob(workerA), claimNextJob(workerB)]);
    expect(jobA?.id).toBeTruthy();
    expect(jobB?.id).toBeTruthy();
    expect(jobA?.id).not.toBe(jobB?.id);
    expect(jobA?.attemptCount).toBe(1);
    expect(jobB?.attemptCount).toBe(1);

    await expect(renewJobLease(jobA!.id, { workerId: workerB, attemptCount: 1 })).resolves.toBe(false);
    await expect(completeJob(jobA!.id, { wrong: true }, { workerId: workerB, attemptCount: 1 })).resolves.toBe(false);
    await expect(completeJob(jobA!.id, { ok: true }, { workerId: workerA, attemptCount: 1 })).resolves.toBe(true);
  });

  it("rejects every write from an expired lease before the reaper runs", async () => {
    const hostId = await insertHost();
    const id = await insertJob("host.check", { hostId });
    const worker = randomUUID();
    const claimed = await claimNextJob(worker);
    expect(claimed?.id).toBe(id);
    await pool.query("UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    const lease = { workerId: worker, attemptCount: 1 };

    await expect(renewJobLease(id, lease)).resolves.toBe(false);
    await expect(completeJob(id, { stale: true }, lease)).resolves.toBe(false);
    await expect(failJob(id, new Error("stale failure"), lease)).resolves.toBe(false);
    await expect(updateJobProgress(id, [{ id: "run", label: "Run", status: "running" }], lease))
      .rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(withActiveJobLeaseTransaction(id, lease, async () => "stale"))
      .rejects.toBeInstanceOf(JobLeaseLostError);
  });

  it("fences host status and inventory execution against an expired worker", async () => {
    const hostId = await insertHost({ demo: true });
    const id = await insertJob("host.check", { hostId });
    const worker = randomUUID();
    await expect(claimNextJob(worker)).resolves.toMatchObject({ id });
    const lease = { workerId: worker, attemptCount: 1 };
    const fence = {
      assertActive: () => assertJobLeaseActive(id, lease),
      withActiveLease: <T>(callback: Parameters<typeof withActiveJobLeaseTransaction<T>>[2]) =>
        withActiveJobLeaseTransaction(id, lease, callback)
    };

    await expect(checkDockerHost(hostId, fence)).resolves.toMatchObject({ demo: true });
    await pool.query("UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    await expect(checkDockerHost(hostId, fence)).rejects.toBeInstanceOf(JobLeaseLostError);
    await expect(pool.query("SELECT last_status FROM docker_hosts WHERE id = $1", [hostId]))
      .resolves.toMatchObject({ rows: [{ last_status: "online" }] });
  });

  it("recovers old NULL-lease rows after grace while leaving recent legacy work alone", async () => {
    const oldId = await insertJob("host.sync", {
      status: "running",
      legacyStartedAt: new Date(Date.now() - 3 * 60_000)
    });
    const recentId = await insertJob("host.sync", {
      status: "running",
      legacyStartedAt: new Date(Date.now() - 30_000)
    });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 1, failed: 0 });
    const rows = await pool.query("SELECT id, status FROM operation_jobs WHERE id = ANY($1::uuid[])", [[oldId, recentId]]);
    expect(rows.rows.find((row) => row.id === oldId)?.status).toBe("queued");
    expect(rows.rows.find((row) => row.id === recentId)?.status).toBe("running");
  });

  it("atomically permits one safe retry and rejects destructive retry", async () => {
    const hostId = await insertHost();
    const safeId = await insertJob("host.check", { status: "failed", attemptCount: 1, hostId });
    const retries = await Promise.all([retryJob(safeId), retryJob(safeId)]);
    expect(retries.filter((result) => result.retried)).toHaveLength(1);
    expect(retries.find((result) => result.retried)?.retried?.id).toBe(safeId);
    const safeRows = await pool.query("SELECT status, attempt_count FROM operation_jobs WHERE id = $1", [safeId]);
    expect(safeRows.rows[0]).toMatchObject({ status: "queued", attempt_count: 1 });

    const unsafeId = await insertJob("migration.execute", { status: "failed", attemptCount: 1, hostId });
    await expect(retryJob(unsafeId)).resolves.toMatchObject({ retried: null });

    const exhaustedId = await insertJob("host.sync", { status: "failed", attemptCount: 3, hostId });
    await expect(retryJob(exhaustedId)).resolves.toMatchObject({ retried: null });
  });

  it("requeues safe expired work but fails an abandoned mutation", async () => {
    const safeId = await insertJob("host.sync", { status: "running", attemptCount: 1, expired: true });
    const unsafeId = await insertJob("container.restart", { status: "running", attemptCount: 1, expired: true });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 1, failed: 1 });
    const rows = await pool.query("SELECT id, status, error, lease_owner FROM operation_jobs ORDER BY id");
    const safe = rows.rows.find((row) => row.id === safeId);
    const unsafe = rows.rows.find((row) => row.id === unsafeId);
    expect(safe).toMatchObject({ status: "queued", lease_owner: null });
    expect(safe.error).toContain("WORKER_LOST");
    expect(unsafe).toMatchObject({ status: "failed", lease_owner: null });
    expect(unsafe.error).toContain("WORKER_LOST");
  });

  it("backfills only legacy worker-generated migration children and preserves reusable supplied points", async () => {
    const hostId = await insertHost();
    const migrationRunId = randomUUID();
    const generatedPreCopyId = randomUUID();
    const generatedFinalId = randomUUID();
    const suppliedPointId = randomUUID();
    const appIdentity = { kind: "standalone", containerIds: ["demo"] };
    await pool.query(
      `INSERT INTO migration_runs
         (id, source_host_id, target_host_id, source_app_identity, mode, status)
       VALUES ($1, $2, $2, $3, 'execute', 'running')`,
      [migrationRunId, hostId, appIdentity]
    );
    await pool.query(
      `INSERT INTO recovery_points
         (id, host_id, name, app_identity, trigger_kind, status)
       VALUES
         ($1, $4, $5, $7, 'pre_migration', 'completed'),
         ($2, $4, $6, $7, 'pre_migration', 'running'),
         ($3, $4, 'Operator supplied point', $7, 'pre_migration', 'completed')`,
      [
        generatedPreCopyId,
        generatedFinalId,
        suppliedPointId,
        hostId,
        `Migration pre-copy ${migrationRunId}`,
        `Migration final ${migrationRunId}`,
        appIdentity
      ]
    );
    await pool.query(
      "UPDATE migration_runs SET recovery_point_id = $2 WHERE id = $1",
      [migrationRunId, suppliedPointId]
    );

    const migrationSql = await readFile(
      new URL("../../../../infra/postgres/030_migration_plan_binding.sql", import.meta.url),
      "utf8"
    );
    await pool.query(migrationSql);

    const points = await pool.query(
      "SELECT id, migration_run_id FROM recovery_points WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[generatedPreCopyId, generatedFinalId, suppliedPointId]]
    );
    expect(points.rows.find((row) => row.id === generatedPreCopyId)?.migration_run_id).toBe(migrationRunId);
    expect(points.rows.find((row) => row.id === generatedFinalId)?.migration_run_id).toBe(migrationRunId);
    expect(points.rows.find((row) => row.id === suppliedPointId)?.migration_run_id).toBeNull();
  });

  it("fails recovery artifacts, migration child recovery state, and linked clone backups", async () => {
    const hostId = await insertHost();
    const recoveryPointId = randomUUID();
    const recoveryArtifactId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_points (id, host_id, app_identity, trigger_kind, status)
       VALUES ($1, $2, $3, 'manual', 'running')`,
      [recoveryPointId, hostId, { kind: "standalone", containerIds: ["demo"] }]
    );
    await pool.query(
      `INSERT INTO recovery_artifacts (id, recovery_point_id, kind, storage_key, status)
       VALUES ($1, $2, 'metadata', 'manifest.json', 'running')`,
      [recoveryArtifactId, recoveryPointId]
    );
    await insertJob("recovery.create", {
      status: "running",
      attemptCount: 1,
      expired: true,
      hostId,
      payload: { recoveryPointId }
    });

    const migrationPointId = randomUUID();
    const migrationArtifactId = randomUUID();
    const migrationRunId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_points (id, host_id, app_identity, trigger_kind, status)
       VALUES ($1, $2, $3, 'pre_migration', 'running')`,
      [migrationPointId, hostId, { kind: "standalone", containerIds: ["demo"] }]
    );
    await pool.query(
      `INSERT INTO recovery_artifacts (id, recovery_point_id, kind, storage_key, status)
       VALUES ($1, $2, 'metadata', 'manifest.json', 'queued')`,
      [migrationArtifactId, migrationPointId]
    );
    await pool.query(
      `INSERT INTO migration_runs
         (id, source_host_id, target_host_id, source_app_identity, mode, status, recovery_point_id)
       VALUES ($1, $2, $2, $3, 'execute', 'running', $4)`,
      [migrationRunId, hostId, { kind: "standalone", containerIds: ["demo"] }, migrationPointId]
    );
    await pool.query(
      "UPDATE recovery_points SET migration_run_id = $2 WHERE id = $1",
      [migrationPointId, migrationRunId]
    );
    const warmPreCopyPointId = randomUUID();
    const warmPreCopyArtifactId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_points
         (id, host_id, app_identity, trigger_kind, status, migration_run_id)
       VALUES ($1, $2, $3, 'pre_migration', 'running', $4)`,
      [warmPreCopyPointId, hostId, { kind: "standalone", containerIds: ["demo"] }, migrationRunId]
    );
    await pool.query(
      `INSERT INTO recovery_artifacts (id, recovery_point_id, kind, storage_key, status)
       VALUES ($1, $2, 'metadata', 'manifest.json', 'running')`,
      [warmPreCopyArtifactId, warmPreCopyPointId]
    );
    await insertJob("migration.execute", {
      status: "running",
      attemptCount: 1,
      expired: true,
      hostId,
      payload: { migrationRunId, strategy: "clone", stopSource: false, remapPorts: true, networkMode: "clone" }
    });
    // The executor can mark the parent failed before centralized job cleanup.
    // The linked recovery point and artifacts still need to be finalized.
    await pool.query("UPDATE migration_runs SET status = 'failed' WHERE id = $1", [migrationRunId]);

    const backupId = randomUUID();
    await pool.query(
      `INSERT INTO backups (id, host_id, kind, volume_name, file_name, status, metadata)
       VALUES ($1, $2, 'volume', 'clone-source', 'clone.tar.gz', 'running', '{}'::jsonb)`,
      [backupId, hostId]
    );
    await insertJob("volume.clone", {
      status: "running",
      attemptCount: 1,
      expired: true,
      hostId,
      payload: {
        backupId,
        targetHostId: hostId,
        sourceVolumeName: "clone-source",
        targetVolumeName: "clone-target",
        overwrite: false
      }
    });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 3 });
    const points = await pool.query("SELECT id, status FROM recovery_points WHERE id = ANY($1::uuid[])", [[recoveryPointId, migrationPointId, warmPreCopyPointId]]);
    expect(points.rows.every((row) => row.status === "failed")).toBe(true);
    expect(points.rows).toHaveLength(3);
    const artifacts = await pool.query("SELECT id, status FROM recovery_artifacts WHERE id = ANY($1::uuid[])", [[recoveryArtifactId, migrationArtifactId, warmPreCopyArtifactId]]);
    expect(artifacts.rows.every((row) => row.status === "failed")).toBe(true);
    expect(artifacts.rows).toHaveLength(3);
    await expect(pool.query("SELECT status FROM migration_runs WHERE id = $1", [migrationRunId]))
      .resolves.toMatchObject({ rows: [{ status: "failed" }] });
    await expect(pool.query("SELECT status FROM backups WHERE id = $1", [backupId]))
      .resolves.toMatchObject({ rows: [{ status: "failed" }] });
  });
});
