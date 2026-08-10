import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/server.js";
import { env } from "../../src/config/env.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { checkDockerHost } from "../../src/services/docker.js";
import { deleteRecoveryPoint } from "../../src/services/recoveryPointDelete.js";
import { reconcileRecoverySourceRestartObligations } from "../../src/services/recoveryRestartReconciliation.js";
import { reconcileRecoveryRestoreAttempts } from "../../src/services/recoveryRestoreAttempts.js";
import {
  assertJobLeaseActive,
  cancelQueuedJob,
  claimNextJob,
  completeJob,
  enqueueJob,
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
    if (testHostIds.length) {
      await pool.query(
        "DELETE FROM recovery_restore_attempts WHERE target_host_id = ANY($1::uuid[])",
        [testHostIds]
      );
      await pool.query(
        "DELETE FROM recovery_points WHERE host_id = ANY($1::uuid[])",
        [testHostIds]
      );
      await pool.query(
        `DELETE FROM migration_runs
         WHERE source_host_id = ANY($1::uuid[])
            OR target_host_id = ANY($1::uuid[])`,
        [testHostIds]
      );
    }
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

  async function insertRecoveryPoint(
    hostId: string,
    input: {
      id?: string;
      name: string;
      metadata?: Record<string, unknown>;
    }
  ) {
    const id = input.id ?? randomUUID();
    await pool.query(
      `INSERT INTO recovery_points (
         id,
         host_id,
         name,
         app_identity,
         trigger_kind,
         status,
         metadata
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         'pre_migration',
         'completed',
         $5::jsonb
       )`,
      [
        id,
        hostId,
        input.name,
        JSON.stringify({
          kind: "standalone",
          containerIds: ["migration-source-web"]
        }),
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return id;
  }

  async function insertMigrationCompletionFixture(input: {
    strategy: "safe_move" | "warm_move" | "clone";
    sourceLeftStopped: boolean;
    attemptBinding?:
      | "exact"
      | "missing"
      | "mismatched"
      | "wrong_target"
      | "wrong_scope";
    finalMetadata?: Record<string, unknown>;
    siblingMetadata?: Record<string, unknown>;
  }) {
    const sourceHostId = await insertHost();
    const targetHostId = await insertHost();
    const migrationRunId = randomUUID();
    const recoveryPointId = await insertRecoveryPoint(sourceHostId, {
      name: `Final ${input.strategy} recovery`,
      metadata: input.finalMetadata ?? (
        input.sourceLeftStopped
          ? {
              sourceRestartPending: true,
              sourceRestartContainerIds: ["migration-source-web"],
              sourceLeftStopped: true,
              sourceStoppedIds: ["migration-source-web"],
              stoppedContainerIds: ["migration-source-web"],
              restartFailedIds: [],
              sourceRestartReconciliationState: "blocked_target_cleanup",
              sourceRestartReconciliationError: "prior transient diagnostic",
              sourceRestartTargetCleanupBlocked: true,
              sourceRestartTargetCleanupBlockedAt: new Date().toISOString(),
              sourceRestartTargetCleanupError: "cleanup remains armed"
            }
          : {}
      )
    });
    const siblingRecoveryPointId = input.siblingMetadata
      ? await insertRecoveryPoint(sourceHostId, {
          name: `Pre-copy ${input.strategy} recovery`,
          metadata: input.siblingMetadata
        })
      : null;
    const mismatchedRecoveryPointId = input.attemptBinding === "mismatched"
      ? await insertRecoveryPoint(sourceHostId, {
          name: "Mismatched restore attempt owner"
        })
      : null;
    await pool.query(
      `INSERT INTO migration_runs (
         id,
         source_host_id,
         target_host_id,
         source_app_identity,
         mode,
         status,
         recovery_point_id,
         error
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         'execute',
         'running',
         $5,
         'Automatic migration compensation remains armed'
       )`,
      [
        migrationRunId,
        sourceHostId,
        targetHostId,
        JSON.stringify({
          kind: "standalone",
          containerIds: ["migration-source-web"]
        }),
        recoveryPointId
      ]
    );
    await pool.query(
      `UPDATE recovery_points
       SET migration_run_id = $2
       WHERE id = ANY($1::uuid[])`,
      [
        [
          recoveryPointId,
          siblingRecoveryPointId,
          mismatchedRecoveryPointId
        ].filter(Boolean),
        migrationRunId
      ]
    );
    const migrationJobId = await insertJob("migration.execute", {
      hostId: sourceHostId,
      payload: {
        migrationRunId,
        strategy: input.strategy,
        stopSource: false,
        remapPorts: true,
        networkMode: "clone"
      }
    });
    const migrationWorkerId = randomUUID();
    await expect(claimNextJob(migrationWorkerId)).resolves.toMatchObject({
      id: migrationJobId,
      attemptCount: 1
    });
    let restoreAttemptId: string | null = null;
    if (input.attemptBinding !== "missing") {
      restoreAttemptId = randomUUID();
      const attemptRecoveryPointId = mismatchedRecoveryPointId
        ?? recoveryPointId;
      const attemptTargetHostId = input.attemptBinding === "wrong_target"
        ? sourceHostId
        : targetHostId;
      const restoreScope = input.attemptBinding === "wrong_scope"
        ? `migration:${migrationRunId}`
        : attemptRecoveryPointId;
      await pool.query(
        `INSERT INTO recovery_restore_attempts (
           id,
           recovery_point_id,
           target_host_id,
           operation_job_id,
           migration_run_id,
           restore_scope,
           retain_on_success,
           status
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           true,
           'awaiting_disposition'
         )`,
        [
          restoreAttemptId,
          attemptRecoveryPointId,
          attemptTargetHostId,
          migrationJobId,
          migrationRunId,
          restoreScope
        ]
      );
    }
    return {
      sourceHostId,
      targetHostId,
      migrationRunId,
      recoveryPointId,
      siblingRecoveryPointId,
      mismatchedRecoveryPointId,
      migrationJobId,
      migrationWorkerId,
      restoreAttemptId
    };
  }

  type BackupRestoreJobType =
    | "volume.restore"
    | "hostPath.restore"
    | "volume.clone"
    | "backup.drill";

  async function insertBackupRestoreCompletionFixture(input: {
    type: BackupRestoreJobType;
    attemptState?:
      | "exact"
      | "missing"
      | "cleanup_pending"
      | "wrong_target"
      | "wrong_scope"
      | "drill_uncleaned";
    demoTarget?: boolean;
  }) {
    const sourceHostId = await insertHost({
      demo: input.demoTarget === true && input.type !== "volume.clone"
    });
    const targetHostId = input.type === "volume.clone"
      ? await insertHost({ demo: input.demoTarget === true })
      : sourceHostId;
    const wrongTargetHostId = input.attemptState === "wrong_target"
      ? await insertHost()
      : null;
    const backupId = randomUUID();
    const backupKind = input.type === "hostPath.restore"
      ? "host_path"
      : "volume";
    await pool.query(
      `INSERT INTO backups (
         id,
         host_id,
         kind,
         volume_name,
         source_path,
         file_name,
         status,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', '{}'::jsonb)`,
      [
        backupId,
        sourceHostId,
        backupKind,
        input.type === "hostPath.restore"
          ? null
          : "source_data",
        input.type === "hostPath.restore"
          ? "/srv/source"
          : null,
        `${backupId}.tar.gz`
      ]
    );
    const payload = input.type === "volume.restore"
      ? {
          backupId,
          targetVolumeName: "restored_data",
          overwrite: false
        }
      : input.type === "hostPath.restore"
        ? {
            backupId,
            targetPath: "/srv/restored",
            overwrite: false
          }
        : input.type === "volume.clone"
          ? {
              backupId,
              targetHostId,
              sourceVolumeName: "source_data",
              targetVolumeName: "cloned_data",
              overwrite: false
            }
          : {
              backupId,
              drillId: randomUUID()
            };
    const jobId = await insertJob(input.type, {
      hostId: sourceHostId,
      payload
    });
    const workerId = randomUUID();
    await expect(claimNextJob(workerId)).resolves.toMatchObject({
      id: jobId,
      attemptCount: 1
    });
    let attemptId: string | null = null;
    if (
      input.attemptState !== "missing"
      && input.demoTarget !== true
    ) {
      attemptId = randomUUID();
      const drill = input.type === "backup.drill";
      const awaitingDrill =
        input.attemptState === "drill_uncleaned";
      await pool.query(
        `INSERT INTO recovery_restore_attempts (
           id,
           backup_id,
           target_host_id,
           operation_job_id,
           restore_scope,
           retain_on_success,
           status,
           completed_at
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $5,
           $6,
           $7,
           CASE WHEN $7 = 'cleaned' THEN now() ELSE NULL END
         )`,
        [
          attemptId,
          backupId,
          wrongTargetHostId ?? targetHostId,
          jobId,
          input.attemptState === "wrong_scope"
            ? `wrong:${backupId}`
            : `backup:${backupId}`,
          !drill,
          input.attemptState === "cleanup_pending"
            ? "cleanup_pending"
            : drill && !awaitingDrill
              ? "cleaned"
              : "awaiting_disposition"
        ]
      );
    }
    const result = input.type === "volume.clone"
      ? {
          backupId,
          targetHostId,
          targetVolumeName: "cloned_data"
        }
      : input.type === "backup.drill"
        ? {
            backupId,
            status: "completed",
            drillId: payload.drillId
          }
        : { stdout: "restored", stderr: "" };
    return {
      sourceHostId,
      targetHostId,
      wrongTargetHostId,
      backupId,
      jobId,
      workerId,
      attemptId,
      result
    };
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

  it("keeps readiness HTTP successful for Docker while a self-update handoff drains workers", async () => {
    const hostId = await insertHost();
    const handoffJobId = await insertJob("system.self_update", {
      status: "running",
      attemptCount: 1,
      hostId,
      payload: {
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "latest",
        targetVersion: "latest"
      }
    });
    await pool.query(
      `UPDATE operation_jobs
       SET result = $2::jsonb
       WHERE id = $1`,
      [handoffJobId, JSON.stringify({ handoffPending: true, handedOffAt: new Date().toISOString() })]
    );
    await registerWorkerInstance({
      id: randomUUID(),
      version: "1.2.0-beta.1",
      hostname: "integration-worker-a"
    });
    await registerWorkerInstance({
      id: randomUUID(),
      version: "1.2.0-beta.1",
      hostname: "integration-worker-b"
    });

    const blocked = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({
      ok: false,
      checks: {
        database: { ok: true, required: true },
        worker: {
          ok: false,
          available: false,
          activeWorkers: 2,
          state: "draining"
        }
      }
    });

    await pool.query(
      `UPDATE operation_jobs
       SET status = 'completed',
           result = result || '{"handoffPending":false}'::jsonb,
           completed_at = now()
       WHERE id = $1`,
      [handoffJobId]
    );
    const resolved = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().checks.worker).toMatchObject({
      ok: true,
      available: true,
      activeWorkers: 2,
      state: "active"
    });
  });

  it("still fails readiness HTTP when workers are absent during a self-update handoff", async () => {
    const hostId = await insertHost();
    const handoffJobId = await insertJob("system.self_update", {
      status: "running",
      attemptCount: 1,
      hostId,
      payload: {
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "latest",
        targetVersion: "latest"
      }
    });
    await pool.query(
      `UPDATE operation_jobs
       SET result = $2::jsonb
       WHERE id = $1`,
      [handoffJobId, JSON.stringify({ handoffPending: true, handedOffAt: new Date().toISOString() })]
    );

    const blocked = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({
      ok: false,
      checks: {
        worker: {
          ok: false,
          available: false,
          activeWorkers: 0
        }
      }
    });
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

  it("publishes a completed recovery restore with its retained attempt", async () => {
    const targetHostId = await insertHost();
    const recoveryPointId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_points (
         id, host_id, name, app_identity, trigger_kind, status
       )
       VALUES ($1, $2, 'Atomic restore completion', $3::jsonb, 'manual', 'completed')`,
      [
        recoveryPointId,
        targetHostId,
        JSON.stringify({
          kind: "standalone",
          containerIds: ["atomic-restore"]
        })
      ]
    );
    const restoreJobId = await insertJob("recovery.restore", {
      hostId: targetHostId,
      payload: { recoveryPointId }
    });
    const restoreWorkerId = randomUUID();
    await expect(claimNextJob(restoreWorkerId)).resolves.toMatchObject({
      id: restoreJobId,
      attemptCount: 1
    });
    const restoreAttemptId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_restore_attempts (
         id,
         recovery_point_id,
         target_host_id,
         operation_job_id,
         restore_scope,
         retain_on_success,
         status
       )
       VALUES ($1, $2, $3, $4, $5, true, 'awaiting_disposition')`,
      [
        restoreAttemptId,
        recoveryPointId,
        targetHostId,
        restoreJobId,
        recoveryPointId
      ]
    );

    await expect(completeJob(
      restoreJobId,
      { composeRestored: true },
      { workerId: restoreWorkerId, attemptCount: 1 }
    )).resolves.toBe(true);

    const published = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.id AS attempt_id,
         attempt.status AS attempt_status,
         attempt.completed_at AS attempt_completed_at
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       WHERE job.id = $1`,
      [restoreJobId]
    );
    expect(published.rows.find((row) =>
      row.attempt_id === restoreAttemptId
    )).toMatchObject({
      job_status: "completed",
      attempt_status: "retained",
      attempt_completed_at: expect.any(Date)
    });
    expect(published.rowCount).toBe(1);

    await expect(deleteRecoveryPoint(recoveryPointId)).resolves.toMatchObject({
      id: recoveryPointId
    });
    await expect(pool.query(
      "SELECT id FROM recovery_points WHERE id = $1",
      [recoveryPointId]
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("publishes a completed recovery drill only after exact cleanup", async () => {
    const targetHostId = await insertHost();
    const recoveryPointId = await insertRecoveryPoint(targetHostId, {
      name: "Atomic recovery drill completion"
    });
    const restoreJobId = await insertJob("recovery.restore", {
      hostId: targetHostId,
      payload: { recoveryPointId, drill: true }
    });
    const restoreWorkerId = randomUUID();
    await expect(claimNextJob(restoreWorkerId)).resolves.toMatchObject({
      id: restoreJobId,
      attemptCount: 1
    });
    const restoreAttemptId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_restore_attempts (
         id,
         recovery_point_id,
         target_host_id,
         operation_job_id,
         restore_scope,
         retain_on_success,
         status,
         completed_at
       )
       VALUES ($1, $2, $3, $4, $5, false, 'cleaned', now())`,
      [
        restoreAttemptId,
        recoveryPointId,
        targetHostId,
        restoreJobId,
        recoveryPointId
      ]
    );

    await expect(completeJob(
      restoreJobId,
      { composeRestored: true },
      { workerId: restoreWorkerId, attemptCount: 1 }
    )).resolves.toBe(true);

    const published = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       WHERE job.id = $1`,
      [restoreJobId]
    );
    expect(published.rows[0]).toEqual({
      job_status: "completed",
      attempt_status: "cleaned"
    });
    await expect(deleteRecoveryPoint(recoveryPointId)).resolves.toMatchObject({
      id: recoveryPointId
    });
  });

  it.each([
    "missing",
    "mismatched",
    "cleanup_pending"
  ] as const)(
    "rolls back recovery completion for a %s authoritative attempt",
    async (attemptState) => {
      const targetHostId = await insertHost();
      const recoveryPointId = await insertRecoveryPoint(targetHostId, {
        name: `Fail-closed recovery ${attemptState}`
      });
      const wrongRecoveryPointId = attemptState === "mismatched"
        ? await insertRecoveryPoint(targetHostId, {
            name: "Wrong recovery attempt owner"
          })
        : null;
      const restoreJobId = await insertJob("recovery.restore", {
        hostId: targetHostId,
        payload: { recoveryPointId, drill: false }
      });
      const restoreWorkerId = randomUUID();
      await expect(claimNextJob(restoreWorkerId)).resolves.toMatchObject({
        id: restoreJobId,
        attemptCount: 1
      });
      let restoreAttemptId: string | null = null;
      if (attemptState !== "missing") {
        restoreAttemptId = randomUUID();
        await pool.query(
          `INSERT INTO recovery_restore_attempts (
             id,
             recovery_point_id,
             target_host_id,
             operation_job_id,
             restore_scope,
             retain_on_success,
             status
           )
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [
            restoreAttemptId,
            wrongRecoveryPointId ?? recoveryPointId,
            targetHostId,
            restoreJobId,
            wrongRecoveryPointId ?? recoveryPointId,
            attemptState === "cleanup_pending"
              ? "cleanup_pending"
              : "awaiting_disposition"
          ]
        );
      }

      await expect(completeJob(
        restoreJobId,
        { composeRestored: true },
        { workerId: restoreWorkerId, attemptCount: 1 }
      )).rejects.toThrow(/authoritative restore attempt|exact operation identity|await retention/);

      const job = await pool.query(
        "SELECT status, completed_at FROM operation_jobs WHERE id = $1",
        [restoreJobId]
      );
      expect(job.rows[0]).toMatchObject({
        status: "running",
        completed_at: null
      });
      if (restoreAttemptId) {
        const attempt = await pool.query(
          "SELECT status, completed_at FROM recovery_restore_attempts WHERE id = $1",
          [restoreAttemptId]
        );
        expect(attempt.rows[0]).toMatchObject({
          status: attemptState === "cleanup_pending"
            ? "cleanup_pending"
            : "awaiting_disposition",
          completed_at: null
        });
      }
    }
  );

  it.each([
    "volume.restore",
    "hostPath.restore",
    "volume.clone",
    "backup.drill"
  ] as const)(
    "atomically publishes %s only with its exact backup restore attempt",
    async (type) => {
      const fixture = await insertBackupRestoreCompletionFixture({
        type,
        attemptState: "exact"
      });

      await expect(completeJob(
        fixture.jobId,
        fixture.result,
        { workerId: fixture.workerId, attemptCount: 1 }
      )).resolves.toBe(true);

      const published = await pool.query(
        `SELECT
           job.status AS job_status,
           attempt.status AS attempt_status,
           attempt.backup_id AS attempt_backup_id,
           attempt.target_host_id AS attempt_target_host_id,
           attempt.restore_scope AS attempt_restore_scope
         FROM operation_jobs job
         JOIN recovery_restore_attempts attempt
           ON attempt.operation_job_id = job.id
         WHERE job.id = $1`,
        [fixture.jobId]
      );
      expect(published.rows[0]).toEqual({
        job_status: "completed",
        attempt_status: type === "backup.drill"
          ? "cleaned"
          : "retained",
        attempt_backup_id: fixture.backupId,
        attempt_target_host_id: fixture.targetHostId,
        attempt_restore_scope: `backup:${fixture.backupId}`
      });
    }
  );

  it.each([
    "volume.restore",
    "hostPath.restore",
    "volume.clone",
    "backup.drill"
  ] as const)(
    "allows verified demo %s completion without a remote restore attempt",
    async (type) => {
      const fixture = await insertBackupRestoreCompletionFixture({
        type,
        attemptState: "missing",
        demoTarget: true
      });

      await expect(completeJob(
        fixture.jobId,
        fixture.result,
        { workerId: fixture.workerId, attemptCount: 1 }
      )).resolves.toBe(true);
      await expect(pool.query(
        "SELECT status FROM operation_jobs WHERE id = $1",
        [fixture.jobId]
      )).resolves.toMatchObject({
        rows: [{ status: "completed" }]
      });
      await expect(pool.query(
        "SELECT id FROM recovery_restore_attempts WHERE operation_job_id = $1",
        [fixture.jobId]
      )).resolves.toMatchObject({
        rowCount: 0
      });
    }
  );

  it.each([
    ["volume.restore", "missing"],
    ["hostPath.restore", "cleanup_pending"],
    ["volume.clone", "wrong_target"],
    ["volume.restore", "wrong_scope"],
    ["backup.drill", "drill_uncleaned"]
  ] as const)(
    "rolls back %s completion for a %s authoritative attempt",
    async (type, attemptState) => {
      const fixture = await insertBackupRestoreCompletionFixture({
        type,
        attemptState
      });

      await expect(completeJob(
        fixture.jobId,
        fixture.result,
        { workerId: fixture.workerId, attemptCount: 1 }
      )).rejects.toThrow(
        /authoritative restore attempt|exact operation identity|await retention|requires its exact restore attempt/
      );

      await expect(pool.query(
        "SELECT status, completed_at FROM operation_jobs WHERE id = $1",
        [fixture.jobId]
      )).resolves.toMatchObject({
        rows: [{
          status: "running",
          completed_at: null
        }]
      });
      if (fixture.attemptId) {
        const expectedStatus = attemptState === "cleanup_pending"
          ? "cleanup_pending"
          : "awaiting_disposition";
        await expect(pool.query(
          "SELECT status, completed_at FROM recovery_restore_attempts WHERE id = $1",
          [fixture.attemptId]
        )).resolves.toMatchObject({
          rows: [{
            status: expectedStatus,
            completed_at: null
          }]
        });
      }
    }
  );

  it("atomically publishes migration, restore, and stopped-source success state", async () => {
    const sourceHostId = await insertHost();
    const targetHostId = await insertHost();
    const migrationRunId = randomUUID();
    const recoveryPointId = randomUUID();
    const sourceContainerIds = ["migration-source-web", "migration-source-worker"];
    await pool.query(
      `INSERT INTO recovery_points (
         id,
         host_id,
         name,
         app_identity,
         trigger_kind,
         status,
         metadata
       )
       VALUES (
         $1,
         $2,
         'Atomic migration recovery',
         $3::jsonb,
         'pre_migration',
         'completed',
         $4::jsonb
       )`,
      [
        recoveryPointId,
        sourceHostId,
        JSON.stringify({
          kind: "standalone",
          containerIds: sourceContainerIds
        }),
        JSON.stringify({
          sourceRestartPending: true,
          sourceRestartContainerIds: sourceContainerIds,
          sourceLeftStopped: true,
          sourceStoppedIds: sourceContainerIds,
          stoppedContainerIds: sourceContainerIds,
          restartFailedIds: [],
          sourceRestartReconciliationState: "blocked_target_cleanup",
          sourceRestartTargetCleanupBlocked: true
        })
      ]
    );
    await pool.query(
      `INSERT INTO migration_runs (
         id,
         source_host_id,
         target_host_id,
         source_app_identity,
         mode,
         status,
         recovery_point_id,
         error
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         'execute',
         'running',
         $5,
         'Automatic migration compensation remains armed'
       )`,
      [
        migrationRunId,
        sourceHostId,
        targetHostId,
        JSON.stringify({
          kind: "standalone",
          containerIds: sourceContainerIds
        }),
        recoveryPointId
      ]
    );
    await pool.query(
      "UPDATE recovery_points SET migration_run_id = $2 WHERE id = $1",
      [recoveryPointId, migrationRunId]
    );

    const migrationJobId = await insertJob("migration.execute", {
      hostId: sourceHostId,
      payload: {
        migrationRunId,
        strategy: "safe_move",
        stopSource: false,
        remapPorts: true,
        networkMode: "clone"
      }
    });
    const migrationWorkerId = randomUUID();
    await expect(claimNextJob(migrationWorkerId)).resolves.toMatchObject({
      id: migrationJobId,
      attemptCount: 1
    });
    const restoreAttemptId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_restore_attempts (
         id,
         recovery_point_id,
         target_host_id,
         operation_job_id,
         migration_run_id,
         restore_scope,
         retain_on_success,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, 'awaiting_disposition')`,
      [
        restoreAttemptId,
        recoveryPointId,
        targetHostId,
        migrationJobId,
        migrationRunId,
        recoveryPointId
      ]
    );

    await expect(completeJob(
      migrationJobId,
      {
        migrationRunId,
        recoveryPointId,
        strategy: "safe_move",
        sourceLeftStopped: true
      },
      { workerId: randomUUID(), attemptCount: 1 }
    )).resolves.toBe(false);
    const fencedOut = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status,
         migration.status AS migration_status,
         point.metadata->>'sourceRestartPending' AS source_restart_pending
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN migration_runs migration
         ON migration.id = attempt.migration_run_id
       JOIN recovery_points point
         ON point.id = attempt.recovery_point_id
       WHERE job.id = $1`,
      [migrationJobId]
    );
    expect(fencedOut.rows[0]).toMatchObject({
      job_status: "running",
      attempt_status: "awaiting_disposition",
      migration_status: "running",
      source_restart_pending: "true"
    });

    await expect(completeJob(
      migrationJobId,
      {
        migrationRunId,
        recoveryPointId,
        strategy: "safe_move",
        sourceLeftStopped: true
      },
      { workerId: migrationWorkerId, attemptCount: 1 }
    )).resolves.toBe(true);

    const published = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status,
         migration.status AS migration_status,
         migration.error AS migration_error,
         point.metadata AS point_metadata
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN migration_runs migration
         ON migration.id = attempt.migration_run_id
       JOIN recovery_points point
         ON point.id = attempt.recovery_point_id
       WHERE job.id = $1`,
      [migrationJobId]
    );
    expect(published.rows[0]).toMatchObject({
      job_status: "completed",
      attempt_status: "retained",
      migration_status: "completed",
      migration_error: null,
      point_metadata: expect.objectContaining({
        sourceRestartPending: false,
        sourceRestartContainerIds: [],
        sourceLeftStopped: true,
        sourceStoppedIds: sourceContainerIds,
        stoppedContainerIds: sourceContainerIds,
        restartFailedIds: [],
        sourceRestartResolution: "intentionally_left_stopped",
        sourceRestartReconciliationState: "completed"
      })
    });
    expect(published.rows[0]?.point_metadata.sourceRestartResolvedAt)
      .toEqual(expect.any(String));
    expect(published.rows[0]?.point_metadata)
      .not.toHaveProperty("sourceRestartTargetCleanupBlocked");
    expect(published.rows[0]?.point_metadata)
      .not.toHaveProperty("sourceRestartTargetCleanupBlockedAt");
    expect(published.rows[0]?.point_metadata)
      .not.toHaveProperty("sourceRestartTargetCleanupError");
    expect(published.rows[0]?.point_metadata)
      .not.toHaveProperty("sourceRestartReconciliationError");

    await expect(deleteRecoveryPoint(recoveryPointId)).resolves.toMatchObject({
      id: recoveryPointId
    });
    await expect(pool.query(
      "SELECT id FROM recovery_points WHERE id = $1",
      [recoveryPointId]
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it.each([
    "missing",
    "mismatched",
    "wrong_target",
    "wrong_scope"
  ] as const)(
    "rolls back migration completion for a %s restore attempt",
    async (attemptBinding) => {
      const fixture = await insertMigrationCompletionFixture({
        strategy: "safe_move",
        sourceLeftStopped: true,
        attemptBinding
      });

      await expect(completeJob(
        fixture.migrationJobId,
        {
          migrationRunId: fixture.migrationRunId,
          recoveryPointId: fixture.recoveryPointId,
          strategy: "safe_move",
          sourceLeftStopped: true
        },
        {
          workerId: fixture.migrationWorkerId,
          attemptCount: 1
        }
      )).rejects.toThrow(
        /authoritative restore attempt|exact operation identity|target does not match/
      );

      const durable = await pool.query(
        `SELECT
           job.status AS job_status,
           migration.status AS migration_status
         FROM operation_jobs job
         JOIN migration_runs migration
           ON migration.id = $2
         WHERE job.id = $1`,
        [fixture.migrationJobId, fixture.migrationRunId]
      );
      expect(durable.rows[0]).toEqual({
        job_status: "running",
        migration_status: "running"
      });
      if (fixture.restoreAttemptId) {
        await expect(pool.query(
          "SELECT status FROM recovery_restore_attempts WHERE id = $1",
          [fixture.restoreAttemptId]
        )).resolves.toMatchObject({
          rows: [{ status: "awaiting_disposition" }]
        });
      }
    }
  );

  it("rolls back every terminal write when the exact source obligation is unsafe", async () => {
    const fixture = await insertMigrationCompletionFixture({
      strategy: "safe_move",
      sourceLeftStopped: true,
      finalMetadata: {
        sourceRestartPending: true,
        sourceRestartContainerIds: ["migration-source-web"],
        sourceRestartReconciliationState: "pending",
        sourceRestartTargetCleanupBlocked: false
      }
    });

    await expect(completeJob(
      fixture.migrationJobId,
      {
        migrationRunId: fixture.migrationRunId,
        recoveryPointId: fixture.recoveryPointId,
        strategy: "safe_move",
        sourceLeftStopped: true
      },
      {
        workerId: fixture.migrationWorkerId,
        attemptCount: 1
      }
    )).rejects.toThrow(
      "Migration stopped-source obligation is not safely blocked on target cleanup"
    );

    const durable = await pool.query(
      `SELECT
         job.status AS job_status,
         job.completed_at AS job_completed_at,
         attempt.status AS attempt_status,
         attempt.completed_at AS attempt_completed_at,
         migration.status AS migration_status,
         migration.completed_at AS migration_completed_at,
         point.metadata AS point_metadata
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN migration_runs migration
         ON migration.id = attempt.migration_run_id
       JOIN recovery_points point
         ON point.id = attempt.recovery_point_id
       WHERE job.id = $1`,
      [fixture.migrationJobId]
    );
    expect(durable.rows[0]).toMatchObject({
      job_status: "running",
      job_completed_at: null,
      attempt_status: "awaiting_disposition",
      attempt_completed_at: null,
      migration_status: "running",
      migration_completed_at: null,
      point_metadata: expect.objectContaining({
        sourceRestartPending: true,
        sourceRestartReconciliationState: "pending",
        sourceRestartTargetCleanupBlocked: false
      })
    });
  });

  it("atomically publishes a clone migration with no source-restart obligation", async () => {
    const fixture = await insertMigrationCompletionFixture({
      strategy: "clone",
      sourceLeftStopped: false
    });

    await expect(completeJob(
      fixture.migrationJobId,
      {
        migrationRunId: fixture.migrationRunId,
        recoveryPointId: fixture.recoveryPointId,
        strategy: "clone",
        sourceLeftStopped: false
      },
      {
        workerId: fixture.migrationWorkerId,
        attemptCount: 1
      }
    )).resolves.toBe(true);

    const published = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status,
         migration.status AS migration_status
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN migration_runs migration
         ON migration.id = attempt.migration_run_id
       WHERE job.id = $1`,
      [fixture.migrationJobId]
    );
    expect(published.rows[0]).toEqual({
      job_status: "completed",
      attempt_status: "retained",
      migration_status: "completed"
    });
  });

  it("resolves only the final warm-migration obligation while allowing completed pre-copy points", async () => {
    const fixture = await insertMigrationCompletionFixture({
      strategy: "warm_move",
      sourceLeftStopped: true,
      siblingMetadata: {
        sourceRestartPending: false,
        sourceRestartReconciliationState: "completed",
        captureRole: "pre_copy"
      }
    });

    await expect(completeJob(
      fixture.migrationJobId,
      {
        migrationRunId: fixture.migrationRunId,
        recoveryPointId: fixture.recoveryPointId,
        strategy: "warm_move",
        sourceLeftStopped: true
      },
      {
        workerId: fixture.migrationWorkerId,
        attemptCount: 1
      }
    )).resolves.toBe(true);

    const points = await pool.query(
      `SELECT id, metadata
       FROM recovery_points
       WHERE migration_run_id = $1
       ORDER BY id`,
      [fixture.migrationRunId]
    );
    expect(points.rowCount).toBe(2);
    expect(points.rows.find((row) =>
      row.id === fixture.recoveryPointId
    )?.metadata).toMatchObject({
      sourceRestartPending: false,
      sourceRestartReconciliationState: "completed",
      sourceRestartResolution: "intentionally_left_stopped"
    });
    expect(points.rows.find((row) =>
      row.id === fixture.siblingRecoveryPointId
    )?.metadata).toEqual({
      sourceRestartPending: false,
      sourceRestartReconciliationState: "completed",
      captureRole: "pre_copy"
    });
  });

  it("rolls back warm-migration completion while a stale sibling obligation remains pending", async () => {
    const fixture = await insertMigrationCompletionFixture({
      strategy: "warm_move",
      sourceLeftStopped: true,
      siblingMetadata: {
        sourceRestartPending: true,
        sourceRestartContainerIds: ["stale-pre-copy-source"],
        sourceRestartReconciliationState: "pending",
        sourceRestartTargetCleanupBlocked: false
      }
    });

    await expect(completeJob(
      fixture.migrationJobId,
      {
        migrationRunId: fixture.migrationRunId,
        recoveryPointId: fixture.recoveryPointId,
        strategy: "warm_move",
        sourceLeftStopped: true
      },
      {
        workerId: fixture.migrationWorkerId,
        attemptCount: 1
      }
    )).rejects.toThrow(
      "Migration stopped-source disposition is not bound to its exact final recovery point"
    );

    const durable = await pool.query(
      `SELECT
         job.status AS job_status,
         attempt.status AS attempt_status,
         migration.status AS migration_status
       FROM operation_jobs job
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN migration_runs migration
         ON migration.id = attempt.migration_run_id
       WHERE job.id = $1`,
      [fixture.migrationJobId]
    );
    expect(durable.rows[0]).toEqual({
      job_status: "running",
      attempt_status: "awaiting_disposition",
      migration_status: "running"
    });
  });

  it("enforces an active self-update singleton across concurrent requests", async () => {
    const hostId = await insertHost();
    const action = {
      type: "system.self_update" as const,
      hostId,
      payload: {
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "latest" as const,
        targetVersion: "latest"
      }
    };

    const starts = await Promise.allSettled([
      enqueueJob(action),
      enqueueJob(action)
    ]);

    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = starts.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already queued or running")
    });
    const rows = await pool.query(
      "SELECT id FROM operation_jobs WHERE type = 'system.self_update' AND status IN ('queued', 'running')"
    );
    expect(rows.rowCount).toBe(1);
  });

  it("enforces one active analysis or execution job for each deployment analysis", async () => {
    const hostId = await insertHost();
    const analysisId = randomUUID();
    await enqueueJob({
      type: "deploy.analyze",
      hostId,
      payload: { analysisId }
    });

    await expect(enqueueJob({
      type: "deploy.execute",
      hostId,
      payload: { analysisId }
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already has an analysis or deployment job")
    });
    const rows = await pool.query(
      `SELECT id
       FROM operation_jobs
       WHERE type IN ('deploy.analyze', 'deploy.execute')
         AND payload->>'analysisId' = $1
         AND status IN ('queued', 'running')`,
      [analysisId]
    );
    expect(rows.rowCount).toBe(1);
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

  it("serializes queued cancellation against worker claim and finalizes linked state only when cancellation wins", async () => {
    const hostId = await insertHost();
    const workerId = randomUUID();

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const backupId = randomUUID();
      await pool.query(
        `INSERT INTO backups
           (id, host_id, kind, volume_name, file_name, status, metadata)
         VALUES ($1, $2, 'volume', $3, $4, 'queued', '{}'::jsonb)`,
        [backupId, hostId, `cancel-race-${iteration}`, `cancel-race-${iteration}.tar.gz`]
      );
      const jobId = await insertJob("volume.backup", {
        status: "queued",
        hostId,
        payload: { backupId, volumeName: `cancel-race-${iteration}` }
      });

      const [cancellation, claimed] = await Promise.all([
        cancelQueuedJob(jobId),
        claimNextJob(workerId)
      ]);
      const cancellationWon = cancellation.canceled;
      const claimWon = claimed?.id === jobId;
      expect(Number(cancellationWon) + Number(claimWon)).toBe(1);

      const job = await pool.query(
        "SELECT status FROM operation_jobs WHERE id = $1",
        [jobId]
      );
      const backup = await pool.query(
        "SELECT status, error FROM backups WHERE id = $1",
        [backupId]
      );
      if (cancellationWon) {
        expect(job.rows[0]).toMatchObject({ status: "canceled" });
        expect(backup.rows[0]).toMatchObject({
          status: "failed",
          error: "Canceled before start"
        });
      } else {
        expect(job.rows[0]).toMatchObject({ status: "running" });
        expect(backup.rows[0]).toMatchObject({ status: "queued", error: null });
      }
    }
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

  it("recovers worker loss through target cleanup before restarting the stopped source", async () => {
    const sourceHostId = await insertHost({ demo: true });
    const targetHostId = await insertHost({ demo: true });
    const migrationRunId = randomUUID();
    const recoveryPointId = await insertRecoveryPoint(sourceHostId, {
      name: "Worker-loss compensation chain",
      metadata: {
        sourceRestartPending: true,
        sourceRestartContainerIds: ["source-web", "source-worker"],
        sourceLeftStopped: true,
        sourceStoppedIds: ["source-web", "source-worker"],
        stoppedContainerIds: ["source-web", "source-worker"],
        restartFailedIds: [],
        sourceRestartReconciliationState: "blocked_target_cleanup",
        sourceRestartTargetCleanupBlocked: true,
        sourceRestartTargetCleanupBlockedAt: new Date().toISOString()
      }
    });
    await pool.query(
      `INSERT INTO migration_runs (
         id,
         source_host_id,
         target_host_id,
         source_app_identity,
         mode,
         status,
         recovery_point_id,
         error
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         'execute',
         'running',
         $5,
         'Automatic migration compensation remains armed'
       )`,
      [
        migrationRunId,
        sourceHostId,
        targetHostId,
        JSON.stringify({
          kind: "standalone",
          containerIds: ["source-web", "source-worker"]
        }),
        recoveryPointId
      ]
    );
    await pool.query(
      "UPDATE recovery_points SET migration_run_id = $2 WHERE id = $1",
      [recoveryPointId, migrationRunId]
    );
    const migrationJobId = await insertJob("migration.execute", {
      status: "running",
      attemptCount: 1,
      expired: true,
      hostId: sourceHostId,
      payload: {
        migrationRunId,
        strategy: "safe_move",
        stopSource: false,
        remapPorts: true,
        networkMode: "clone"
      }
    });
    const restoreAttemptId = randomUUID();
    await pool.query(
      `INSERT INTO recovery_restore_attempts (
         id,
         recovery_point_id,
         target_host_id,
         operation_job_id,
         migration_run_id,
         restore_scope,
         retain_on_success,
         status,
         cleanup_not_before
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         true,
         'awaiting_disposition',
         now()
       )`,
      [
        restoreAttemptId,
        recoveryPointId,
        targetHostId,
        migrationJobId,
        migrationRunId,
        recoveryPointId
      ]
    );
    await pool.query(
      `INSERT INTO recovery_restore_resources (
         attempt_id,
         kind,
         resource_name,
         status
       )
       VALUES ($1, 'volume', 'worker-loss-target-volume', 'observed')`,
      [restoreAttemptId]
    );

    await expect(recoverExpiredJobs()).resolves.toEqual({
      requeued: 0,
      failed: 1
    });
    await expect(reconcileRecoverySourceRestartObligations()).resolves.toEqual({
      checked: 0,
      restarted: 0,
      failed: 0
    });
    const blocked = await pool.query(
      `SELECT
         job.status AS job_status,
         migration.status AS migration_status,
         attempt.status AS attempt_status,
         point.metadata AS point_metadata
       FROM operation_jobs job
       JOIN migration_runs migration
         ON migration.id = $2
       JOIN recovery_restore_attempts attempt
         ON attempt.operation_job_id = job.id
       JOIN recovery_points point
         ON point.id = attempt.recovery_point_id
       WHERE job.id = $1`,
      [migrationJobId, migrationRunId]
    );
    expect(blocked.rows[0]).toMatchObject({
      job_status: "failed",
      migration_status: "failed",
      attempt_status: "awaiting_disposition",
      point_metadata: expect.objectContaining({
        sourceRestartPending: true,
        sourceRestartReconciliationState: "blocked_target_cleanup",
        sourceRestartTargetCleanupBlocked: true
      })
    });

    await expect(reconcileRecoveryRestoreAttempts()).resolves.toEqual({
      checked: 1,
      cleaned: 1,
      failed: 0
    });
    const cleanupReleased = await pool.query(
      `SELECT
         attempt.status AS attempt_status,
         resource.status AS resource_status,
         point.metadata AS point_metadata
       FROM recovery_restore_attempts attempt
       JOIN recovery_restore_resources resource
         ON resource.attempt_id = attempt.id
       JOIN recovery_points point
         ON point.id = attempt.recovery_point_id
       WHERE attempt.id = $1`,
      [restoreAttemptId]
    );
    expect(cleanupReleased.rows[0]).toMatchObject({
      attempt_status: "cleaned",
      resource_status: "cleaned",
      point_metadata: expect.objectContaining({
        sourceRestartPending: true,
        sourceRestartReconciliationState: "pending",
        sourceRestartTargetCleanupBlocked: false
      })
    });

    await expect(reconcileRecoverySourceRestartObligations()).resolves.toEqual({
      checked: 1,
      restarted: 1,
      failed: 0
    });
    await expect(pool.query(
      "SELECT metadata FROM recovery_points WHERE id = $1",
      [recoveryPointId]
    )).resolves.toMatchObject({
      rows: [{
        metadata: expect.objectContaining({
          sourceRestartPending: false,
          sourceRestartContainerIds: [],
          sourceLeftStopped: false,
          sourceRestartResolution: "worker_loss_restarted",
          sourceRestartReconciliationState: "completed"
        })
      }]
    });
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
