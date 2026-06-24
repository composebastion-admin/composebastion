import { v4 as uuid } from "uuid";
import type { DockerActionRequest, JobProgressStep, OperationJob } from "@composebastion/shared";
import { dockerActionSchema, jobProgressStepSchema, paginationQuerySchema, paginatedResponse } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { createRedis } from "./redis.js";
import { mapJob } from "./mappers.js";

export async function enqueueJob(
  action: DockerActionRequest,
  createdBy?: string | null,
  idempotencyKey?: string | null
) {
  const parsed = dockerActionSchema.parse(action);

  if (idempotencyKey) {
    const existing = await query("SELECT * FROM operation_jobs WHERE idempotency_key = $1", [idempotencyKey]);
    if (existing.rows[0]) return mapJob(existing.rows[0]);
  }

  const result = await query(
    `INSERT INTO operation_jobs (id, type, host_id, payload, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [uuid(), parsed.type, parsed.hostId, parsed.payload, createdBy ?? null, idempotencyKey ?? null]
  );

  const row = result.rows[0];
  if (!row) throw new Error("Failed to enqueue job");

  const redis = createRedis();
  if (redis) {
    try {
      await redis.connect();
      await redis.publish("jobs:queued", row.id);
    } finally {
      redis.disconnect();
    }
  }

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

export async function updateJobProgress(id: string, steps: JobProgressStep[]) {
  const parsed = steps.map((step) => jobProgressStepSchema.parse(step));
  const result = await query(
    `UPDATE operation_jobs
     SET progress = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(parsed)]
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function markJobProgressStep(jobId: string, type: string, activeStepId: string, detail?: string) {
  return updateJobProgress(jobId, buildJobProgress(type, "running", activeStepId, detail));
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
  const result = await query("SELECT * FROM operation_jobs WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) return { original: null, retried: null };
  const original = mapJob(row);
  if (original.status !== "failed" && original.status !== "canceled") {
    return { original, retried: null };
  }
  if (!original.hostId) {
    return { original, retried: null };
  }
  const retried = await enqueueJob({
    type: original.type,
    hostId: original.hostId,
    payload: original.payload
  } as DockerActionRequest, createdBy ?? null);
  return { original, retried };
}

export async function getWorkerStatus() {
  const result = await query<{ completed_at: Date | string | null }>(
    `SELECT completed_at
     FROM operation_jobs
     WHERE status IN ('completed', 'failed', 'canceled')
     ORDER BY completed_at DESC NULLS LAST
     LIMIT 1`
  );
  const queued = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'queued'"
  );
  const running = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'running'"
  );
  const last = result.rows[0]?.completed_at;
  return {
    queued: Number(queued.rows[0]?.count ?? 0),
    running: Number(running.rows[0]?.count ?? 0),
    lastJobCompletedAt: last ? new Date(last).toISOString() : null
  };
}

export async function claimNextJob() {
  return withTransaction<OperationJob | null>(async (client) => {
    const next = await client.query(
      `SELECT * FROM operation_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    const row = next.rows[0];
    if (!row) return null;

    const updated = await client.query(
      `UPDATE operation_jobs
       SET status = 'running', started_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id]
    );
    return mapJob(updated.rows[0]);
  });
}

export async function completeJob(id: string, result: Record<string, unknown>) {
  await query(
    `UPDATE operation_jobs
     SET status = 'completed', result = $2, error = null, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, result]
  );
}

export async function failJob(id: string, error: unknown) {
  await query(
    `UPDATE operation_jobs
     SET status = 'failed', error = $2, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, error instanceof Error ? error.message : String(error)]
  );
}
