import { v4 as uuid } from "uuid";
import type { PoolClient } from "pg";
import type { DockerActionRequest, JobProgressStep, OperationJob } from "@composebastion/shared";
import { dockerActionSchema, jobProgressStepSchema, paginationQuerySchema, paginatedResponse } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { createRedis } from "./redis.js";
import { mapJob } from "./mappers.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_ACTIVE_WINDOW_SECONDS = 20;
export const JOB_LEASE_SECONDS = 60;
export const JOB_LEASE_MAINTENANCE_INTERVAL_MS = 10_000;
export const MAX_AUTO_ATTEMPTS = 3;

export const AUTO_RETRY_JOB_TYPES = new Set([
  "host.check",
  "host.sync",
  "git.testRemote",
  "backup.verify",
  "recovery.verify"
]);

export type JobLease = {
  workerId: string;
  attemptCount: number;
};

export class JobLeaseLostError extends Error {
  readonly code = "JOB_LEASE_LOST";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} no longer has an active lease`);
    this.name = "JobLeaseLostError";
  }
}

export type JobExecutionFence = {
  assertActive: () => Promise<void>;
  withActiveLease: <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;
};

export type ClaimedOperationJob = OperationJob & JobLease & {
  leaseExpiresAt: string;
};

function mapClaimedJob(row: any): ClaimedOperationJob {
  return {
    ...mapJob(row),
    workerId: row.lease_owner,
    attemptCount: Number(row.attempt_count),
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString()
  };
}

function jobInsert(action: DockerActionRequest, createdBy?: string | null, idempotencyKey?: string | null) {
  const parsed = dockerActionSchema.parse(action);
  return {
    text: `INSERT INTO operation_jobs (id, type, host_id, payload, created_by, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET id = operation_jobs.id
           RETURNING *`,
    values: [uuid(), parsed.type, parsed.hostId, parsed.payload, createdBy ?? null, idempotencyKey ?? null]
  };
}

export async function notifyJobQueued(jobId: string) {
  const redis = createRedis();
  if (!redis) return;
  try {
    await redis.connect();
    await redis.publish("jobs:queued", jobId);
  } catch (error) {
    // PostgreSQL is the durable queue. Redis only reduces pickup latency, so
    // never report a failed request after the job row has committed.
    console.warn("Job wake-up publish failed; database polling will pick it up", {
      jobId,
      errorType: typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "REDIS_ERROR")
        : error instanceof Error ? error.name : "REDIS_ERROR"
    });
  } finally {
    redis.disconnect();
  }
}

/**
 * Insert a job as part of a caller-owned PostgreSQL transaction. The caller
 * must invoke notifyJobQueued(job.id) only after that transaction commits.
 */
export async function enqueueJobInTransaction(
  client: PoolClient,
  action: DockerActionRequest,
  createdBy?: string | null,
  idempotencyKey?: string | null
) {
  const insert = jobInsert(action, createdBy, idempotencyKey);
  const result = await client.query(insert.text, insert.values);
  const row = result.rows[0];
  if (!row) throw new Error("Failed to enqueue job");
  return mapJob(row);
}

export async function enqueueJob(
  action: DockerActionRequest,
  createdBy?: string | null,
  idempotencyKey?: string | null
) {
  const insert = jobInsert(action, createdBy, idempotencyKey);
  const result = await query(insert.text, insert.values);

  const row = result.rows[0];
  if (!row) throw new Error("Failed to enqueue job");

  await notifyJobQueued(row.id);

  return mapJob(row);
}

export async function listJobs(queryInput: unknown) {
  const queryParams = paginationQuerySchema.parse(queryInput);
  const [rows, total] = await Promise.all([
    query(
      `SELECT *
       FROM operation_jobs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [queryParams.limit, queryParams.offset]
    ),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs")
  ]);
  return paginatedResponse(
    rows.rows.map(mapJob),
    Number(total.rows[0]?.count ?? 0),
    queryParams
  );
}

export async function getJob(id: string) {
  const result = await query("SELECT * FROM operation_jobs WHERE id = $1", [id]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

function progressLabels(type: string) {
  if (type === "backup.verify" || type === "recovery.verify") return ["Prepare", "Verify", "Finish"];
  if (type === "backup.drill") return ["Prepare", "Drill", "Verify", "Finish"];
  if (type === "volume.backup" || type === "hostPath.backup" || type === "recovery.create" || type === "recovery.capture") return ["Prepare", "Capture", "Store", "Finish"];
  if (type === "volume.restore" || type === "hostPath.restore" || type === "recovery.restore") return ["Prepare", "Restore", "Verify", "Finish"];
  if (type.startsWith("migration.")) return ["Plan", "Capture", "Transfer", "Deploy", "Verify"];
  if (type.startsWith("compose.") || type === "git.cloneDeploy") return ["Prepare", "Deploy", "Verify"];
  if (type === "system.self_update") return ["Prepare", "Handoff", "Reconnect"];
  if (type === "host.sync") return ["Connect", "Inventory", "Store"];
  if (type === "host.check") return ["Connect", "Check", "Store"];
  if (type.startsWith("image.") || type === "container.update") return ["Inspect", "Apply", "Verify"];
  return ["Run", "Finish"];
}

function stepId(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function buildJobProgress(type: string, phase: "running" | "completed" | "failed", activeStepId?: string, detail?: string): JobProgressStep[] {
  const labels = progressLabels(type);
  const requestedIndex = labels.findIndex((label) => stepId(label) === activeStepId);
  const activeIndex = requestedIndex >= 0 ? requestedIndex : phase === "failed" ? labels.length - 1 : 0;
  return labels.map((label, index) => {
    const status = phase === "running"
      ? index < activeIndex ? "completed" : index === activeIndex ? "running" : "pending"
      : phase === "completed"
        ? "completed"
        : index < activeIndex ? "completed" : index === activeIndex ? "failed" : "pending";
    return jobProgressStepSchema.parse({
      id: stepId(label),
      label,
      status,
      detail: (phase === "running" || phase === "failed") && index === activeIndex ? detail : undefined
    });
  });
}

export async function updateJobProgress(id: string, steps: JobProgressStep[], lease: JobLease) {
  const parsed = steps.map((step) => jobProgressStepSchema.parse(step));
  const predicate = leasePredicate(lease);
  const result = await query(
    `UPDATE operation_jobs
     SET progress = $2, updated_at = now()
     WHERE id = $1${predicate.sql}
     RETURNING *`,
    [id, JSON.stringify(parsed), ...predicate.values]
  );
  if (!result.rows[0]) throw new JobLeaseLostError(id);
  return mapJob(result.rows[0]);
}

export async function markJobProgressStep(jobId: string, type: string, activeStepId: string, detail: string | undefined, lease: JobLease) {
  return updateJobProgress(jobId, buildJobProgress(type, "running", activeStepId, detail), lease);
}

export async function cancelQueuedJob(id: string) {
  const result = await query(
    `UPDATE operation_jobs
     SET status = 'canceled',
         error = 'Canceled before start',
         completed_at = now(),
         updated_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING *`,
    [id]
  );
  if (result.rows[0]) return { job: mapJob(result.rows[0]), canceled: true };
  return { job: await getJob(id), canceled: false };
}

export async function retryJob(id: string, createdBy?: string | null) {
  const result = await withTransaction(async (client) => {
    const selected = await client.query("SELECT * FROM operation_jobs WHERE id = $1 FOR UPDATE", [id]);
    const row = selected.rows[0];
    if (!row) return { original: null, retried: null };
    const original = mapJob(row);
    if (
      (original.status !== "failed" && original.status !== "canceled")
      || !original.hostId
      || !AUTO_RETRY_JOB_TYPES.has(original.type)
      || Number(row.attempt_count ?? 0) >= MAX_AUTO_ATTEMPTS
    ) {
      return { original, retried: null };
    }

    const retriedResult = await client.query(
      `UPDATE operation_jobs
       SET status = 'queued', result = NULL, error = NULL, progress = '[]'::jsonb,
           created_by = COALESCE($2, created_by), started_at = NULL, completed_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1
         AND status IN ('failed', 'canceled')
         AND attempt_count < $3
       RETURNING *`,
      [id, createdBy ?? null, MAX_AUTO_ATTEMPTS]
    );
    return {
      original,
      retried: retriedResult.rows[0] ? mapJob(retriedResult.rows[0]) : null
    };
  });
  if (result.retried) await notifyJobQueued(result.retried.id);
  return result;
}

export async function getWorkerStatus() {
  const [result, queued, running, workers] = await Promise.all([
    query<{ completed_at: Date | string | null }>(
      `SELECT completed_at
       FROM operation_jobs
       WHERE status IN ('completed', 'failed', 'canceled')
       ORDER BY completed_at DESC NULLS LAST
       LIMIT 1`
    ),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'queued'"),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'running'"),
    query<{
      active_count: string;
      recent_draining_count: string;
      last_heartbeat_at: Date | string | null;
      heartbeat_fresh: boolean;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE status = 'active'
             AND last_heartbeat_at >= now() - ($1 * interval '1 second')
         )::text AS active_count,
         count(*) FILTER (
           WHERE status = 'draining'
             AND last_heartbeat_at >= now() - ($1 * interval '1 second')
         )::text AS recent_draining_count,
         max(last_heartbeat_at) AS last_heartbeat_at,
         COALESCE(
           max(last_heartbeat_at) >= now() - ($1 * interval '1 second'),
           false
         ) AS heartbeat_fresh
       FROM worker_instances`,
      [WORKER_ACTIVE_WINDOW_SECONDS]
    )
  ]);
  const last = result.rows[0]?.completed_at;
  const workerRow = workers.rows[0];
  const activeWorkers = Number(workerRow?.active_count ?? 0);
  const recentDrainingWorkers = Number(workerRow?.recent_draining_count ?? 0);
  const lastHeartbeat = workerRow?.last_heartbeat_at;
  const lastHeartbeatAt = lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null;
  const lastHeartbeatIsFresh = workerRow?.heartbeat_fresh ?? false;
  return {
    queued: Number(queued.rows[0]?.count ?? 0),
    running: Number(running.rows[0]?.count ?? 0),
    lastJobCompletedAt: last ? new Date(last).toISOString() : null,
    available: activeWorkers > 0,
    activeWorkers,
    lastHeartbeatAt,
    state: activeWorkers > 0
      ? "active" as const
      : recentDrainingWorkers > 0
        ? "draining" as const
        : lastHeartbeatIsFresh || !lastHeartbeatAt
          ? "absent" as const
          : "stale" as const
  };
}

export async function registerWorkerInstance(input: { id: string; version: string; hostname: string }) {
  await query(
    `INSERT INTO worker_instances (id, version, hostname, status, started_at, last_heartbeat_at, stopped_at)
     VALUES ($1, $2, $3, 'active', now(), now(), NULL)
     ON CONFLICT (id) DO UPDATE
     SET version = EXCLUDED.version,
         hostname = EXCLUDED.hostname,
         status = 'active',
         started_at = now(),
         last_heartbeat_at = now(),
         stopped_at = NULL`,
    [input.id, input.version, input.hostname]
  );
}

export async function heartbeatWorker(id: string) {
  const result = await query(
    `UPDATE worker_instances
     SET last_heartbeat_at = now()
     WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return result.rowCount === 1;
}

export async function markWorkerDraining(id: string) {
  await query(
    `UPDATE worker_instances
     SET status = 'draining', last_heartbeat_at = now()
     WHERE id = $1 AND status = 'active'`,
    [id]
  );
}

export async function markWorkerStopped(id: string) {
  await query(
    `UPDATE worker_instances
     SET status = 'stopped', stopped_at = now(), last_heartbeat_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function cleanupWorkerInstances() {
  await query(
    `DELETE FROM worker_instances
     WHERE (status = 'stopped' AND stopped_at < now() - interval '7 days')
        OR (status <> 'stopped' AND last_heartbeat_at < now() - interval '7 days')`
  );
}

export async function claimNextJob(workerId: string): Promise<ClaimedOperationJob | null> {
  const result = await query(
    `WITH next_job AS (
       SELECT id
       FROM operation_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE operation_jobs AS jobs
     SET status = 'running',
         started_at = COALESCE(jobs.started_at, now()),
         completed_at = NULL,
         error = NULL,
         lease_owner = $1,
         lease_expires_at = now() + ($2 * interval '1 second'),
         attempt_count = jobs.attempt_count + 1,
         updated_at = now()
     FROM next_job
     WHERE jobs.id = next_job.id
     RETURNING jobs.*`,
    [workerId, JOB_LEASE_SECONDS]
  );
  return result.rows[0] ? mapClaimedJob(result.rows[0]) : null;
}

export async function renewJobLease(id: string, lease: JobLease) {
  const result = await query(
    `UPDATE operation_jobs
     SET lease_expires_at = now() + ($4 * interval '1 second'), updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_owner = $2
       AND attempt_count = $3
       AND lease_expires_at > clock_timestamp()`,
    [id, lease.workerId, lease.attemptCount, JOB_LEASE_SECONDS]
  );
  return result.rowCount === 1;
}

function leasePredicate(lease: JobLease) {
  return {
    sql: " AND status = 'running' AND lease_owner = $3 AND attempt_count = $4 AND lease_expires_at > clock_timestamp()",
    values: [lease.workerId, lease.attemptCount]
  };
}

export async function assertJobLeaseActive(id: string, lease: JobLease) {
  const result = await query(
    `SELECT 1
     FROM operation_jobs
     WHERE id = $1
       AND status = 'running'
       AND lease_owner = $2
       AND attempt_count = $3
       AND lease_expires_at > clock_timestamp()`,
    [id, lease.workerId, lease.attemptCount]
  );
  if (result.rowCount !== 1) throw new JobLeaseLostError(id);
}

export async function withActiveJobLeaseTransaction<T>(
  id: string,
  lease: JobLease,
  callback: (client: PoolClient) => Promise<T>
) {
  return withTransaction(async (client) => {
    const active = await client.query(
      `SELECT 1
       FROM operation_jobs
       WHERE id = $1
         AND status = 'running'
         AND lease_owner = $2
         AND attempt_count = $3
         AND lease_expires_at > clock_timestamp()
       FOR UPDATE`,
      [id, lease.workerId, lease.attemptCount]
    );
    if (active.rowCount !== 1) throw new JobLeaseLostError(id);
    return callback(client);
  });
}

export async function completeJob(id: string, resultValue: Record<string, unknown>, lease: JobLease) {
  const predicate = leasePredicate(lease);
  const result = await query(
    `UPDATE operation_jobs
     SET status = 'completed', result = $2, error = null, completed_at = now(),
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1${predicate.sql}
     RETURNING id`,
    [id, resultValue, ...predicate.values]
  );
  return result.rowCount === 1;
}

async function finalizeLinkedOperationFailure(client: PoolClient, row: any, message: string) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  if ((row.type === "volume.backup" || row.type === "hostPath.backup" || row.type === "volume.clone") && typeof payload.backupId === "string") {
    await client.query(
      `UPDATE backups SET status = 'failed', error = $2, completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.backupId, message]
    );
    await client.query(
      `UPDATE backup_schedules AS schedules
       SET last_status = 'failed', last_error = $2, updated_at = now()
       FROM backups
       WHERE backups.id = $1
         AND schedules.id::text = backups.metadata->>'scheduleId'`,
      [payload.backupId, message]
    );
  }

  if (row.type === "backup.drill" && typeof payload.backupId === "string") {
    await client.query(
      `UPDATE backups
       SET last_drill_at = now(), last_drill_status = 'failed'
       WHERE id = $1`,
      [payload.backupId]
    );
  }

  if ((row.type === "recovery.create" || row.type === "recovery.capture") && typeof payload.recoveryPointId === "string") {
    await client.query(
      `UPDATE recovery_points SET status = 'failed', error = $2, completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_artifacts
       SET status = 'failed', error = $2, completed_at = now()
       WHERE recovery_point_id = $1 AND status IN ('queued', 'running')`,
      [payload.recoveryPointId, message]
    );
  }

  if (row.type === "recovery.restore" && payload.drill === true && typeof payload.recoveryPointId === "string") {
    await client.query(
      `UPDATE recovery_points
       SET last_drill_at = now(), last_drill_status = 'failed', last_drill_error = $2
       WHERE id = $1`,
      [payload.recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_schedules AS schedules
       SET last_drill_at = now(), last_drill_status = 'failed', last_drill_error = $2, updated_at = now()
       FROM recovery_points
       WHERE recovery_points.id = $1
         AND schedules.id::text = recovery_points.metadata->>'scheduleId'`,
      [payload.recoveryPointId, message]
    );
  }

  if (row.type === "migration.execute" && typeof payload.migrationRunId === "string") {
    // The migration executor records its own failure before the operation job is
    // finalized. Read the linked recovery point independently of that status
    // transition so child capture rows cannot remain running when the worker is
    // subsequently lost or the job failure is centralized here.
    const migration = await client.query<{ recovery_point_id: string | null }>(
      `SELECT recovery_point_id
       FROM migration_runs
       WHERE id = $1
       FOR UPDATE`,
      [payload.migrationRunId]
    );
    await client.query(
      `UPDATE migration_runs SET status = 'failed', error = $2, completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.migrationRunId, message]
    );
    const recoveryPointId = migration.rows[0]?.recovery_point_id ?? null;
    await client.query(
      `UPDATE recovery_points
       SET status = 'failed', error = $3, completed_at = now()
       WHERE (migration_run_id = $1 OR id = $2)
         AND status IN ('queued', 'running')`,
      [payload.migrationRunId, recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_artifacts
       SET status = 'failed', error = $3, completed_at = now()
       WHERE recovery_point_id IN (
         SELECT id
         FROM recovery_points
         WHERE migration_run_id = $1 OR id = $2
       )
         AND status IN ('queued', 'running')`,
      [payload.migrationRunId, recoveryPointId, message]
    );
  }
}

export async function failJob(id: string, error: unknown, lease: JobLease) {
  const message = error instanceof Error ? error.message : String(error);
  return withTransaction(async (client) => {
    const values: unknown[] = [id, message];
    const predicate = " AND status = 'running' AND lease_owner = $3 AND attempt_count = $4 AND lease_expires_at > clock_timestamp()";
    values.push(lease.workerId, lease.attemptCount);
    const result = await client.query(
      `UPDATE operation_jobs
       SET status = 'failed', error = $2, completed_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1${predicate}
       RETURNING *`,
      values
    );
    const row = result.rows[0];
    if (!row) return false;
    await finalizeLinkedOperationFailure(client, row, message);
    return true;
  });
}

export async function recoverExpiredJobs() {
  return withTransaction(async (client) => {
    const expired = await client.query(
      `SELECT *
       FROM operation_jobs
       WHERE status = 'running'
         AND (
           lease_expires_at <= now()
           OR (
             lease_owner IS NULL
             AND lease_expires_at IS NULL
             AND COALESCE(started_at, updated_at, created_at) <= now() - interval '2 minutes'
           )
         )
       ORDER BY lease_expires_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 100`
    );
    let requeued = 0;
    let failed = 0;
    for (const row of expired.rows) {
      const message = `WORKER_LOST: Worker lease expired during attempt ${Number(row.attempt_count)}`;
      if (AUTO_RETRY_JOB_TYPES.has(row.type) && Number(row.attempt_count) < MAX_AUTO_ATTEMPTS) {
        await client.query(
          `UPDATE operation_jobs
           SET status = 'queued', started_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
               error = $2, progress = '[]'::jsonb, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [row.id, message]
        );
        requeued += 1;
      } else {
        await client.query(
          `UPDATE operation_jobs
           SET status = 'failed', error = $2, completed_at = now(),
               lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [row.id, message]
        );
        await finalizeLinkedOperationFailure(client, row, message);
        failed += 1;
      }
    }
    return { requeued, failed };
  });
}
