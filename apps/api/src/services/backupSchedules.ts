import { v4 as uuid } from "uuid";
import { backupScheduleCreateSchema } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { enqueueJobInTransaction, notifyJobQueued } from "./jobs.js";
import { withTransaction } from "../db/pool.js";
import {
  assertBackupTargetUsable,
  insertPreparedBackupRecord,
  prepareBackupRecord,
  prepareHostPathBackupRecord,
  type PreparedBackupRecord
} from "./backups.js";
import { recordBackupScheduleResult } from "./backupFailureAlerts.js";
import { normalizeHostSourcePath } from "./backupHostPaths.js";

function parseCreateInput(input: unknown) {
  const raw = input && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const withKind = raw.kind ? raw : { ...raw, kind: "volume" };
  return backupScheduleCreateSchema.parse(withKind);
}

function mapBackupSchedule(row: any) {
  return {
    id: row.id,
    hostId: row.host_id,
    kind: row.kind ?? "volume",
    volumeName: row.volume_name ?? null,
    sourcePath: row.source_path ?? null,
    backupTargetId: row.backup_target_id ?? null,
    encryption: row.encryption ?? "none",
    intervalMs: Number(row.interval_ms),
    retentionCount: row.retention_count === null || row.retention_count === undefined
      ? null
      : Number(row.retention_count),
    enabled: row.enabled,
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    nextRunAt: new Date(row.next_run_at).toISOString(),
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listBackupSchedules() {
  const result = await query(
    `SELECT id, host_id, kind, volume_name, source_path, backup_target_id, encryption, interval_ms,
            retention_count, enabled, last_run_at, next_run_at, last_status, last_error,
            created_at, updated_at
     FROM backup_schedules
     ORDER BY next_run_at ASC`
  );
  return result.rows.map(mapBackupSchedule);
}

export async function createBackupSchedule(input: unknown, createdBy?: string | null) {
  const body = parseCreateInput(input);
  const id = uuid();
  const nextRunAt = new Date(Date.now() + body.intervalMs);
  const backupTargetId = await assertBackupTargetUsable(body.backupTargetId);
  const volumeName = body.kind === "volume" ? body.volumeName : null;
  const sourcePath = body.kind === "host_path" ? normalizeHostSourcePath(body.sourcePath) : null;
  const result = await query(
    `INSERT INTO backup_schedules
      (id, host_id, kind, volume_name, source_path, backup_target_id, encryption, interval_ms, retention_count, next_run_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      id,
      body.hostId,
      body.kind,
      volumeName,
      sourcePath,
      backupTargetId,
      body.encryption,
      body.intervalMs,
      body.retentionCount ?? null,
      nextRunAt,
      createdBy ?? null
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create backup schedule");
  return mapBackupSchedule(row);
}

export async function deleteBackupSchedule(id: string) {
  const result = await query("DELETE FROM backup_schedules WHERE id = $1 RETURNING *", [id]);
  return result.rows[0] ? mapBackupSchedule(result.rows[0]) : null;
}

async function prepareScheduledBackupRecord(schedule: any): Promise<PreparedBackupRecord> {
  const metadata = {
    scheduleId: schedule.id,
    retentionCount: schedule.retention_count ?? null
  };

  if (schedule.kind === "host_path") {
    const sourcePath = normalizeHostSourcePath(schedule.source_path);
    return prepareHostPathBackupRecord(schedule.host_id, sourcePath, {
      backupTargetId: schedule.backup_target_id ?? null,
      metadata,
      encryption: schedule.encryption ?? "none"
    });
  }

  return prepareBackupRecord(schedule.host_id, schedule.volume_name, {
    backupTargetId: schedule.backup_target_id ?? null,
    metadata,
    encryption: schedule.encryption ?? "none"
  });
}

export async function runDueBackupSchedules() {
  const due = await query(
    `SELECT *
     FROM backup_schedules
     WHERE enabled = true AND next_run_at <= now()
     ORDER BY next_run_at ASC
     LIMIT 20`
  );

  for (const row of due.rows) {
    try {
      // Resolve target policy, paths, encryption metadata, and filesystem setup
      // before opening the schedule transaction. Only durable rows belong in it.
      const prepared = await prepareScheduledBackupRecord(row);
      const scheduled = await withTransaction(async (client) => {
        const locked = await client.query(
          `SELECT * FROM backup_schedules WHERE id = $1 FOR UPDATE`,
          [row.id]
        );
        const current = locked.rows[0];
        if (!current || !current.enabled || new Date(current.next_run_at) > new Date()) {
          return null;
        }

        const nextRunAt = new Date(Date.now() + Number(current.interval_ms));
        await client.query(
          `UPDATE backup_schedules
           SET last_run_at = now(), next_run_at = $2, last_status = 'queued',
               last_error = null, updated_at = now()
           WHERE id = $1`,
          [current.id, nextRunAt]
        );
        const backup = await insertPreparedBackupRecord(client, prepared);
        const job = await enqueueJobInTransaction(
          client,
          prepared.kind === "host_path"
            ? {
              type: "hostPath.backup",
              hostId: current.host_id,
              payload: { backupId: backup.id, sourcePath: prepared.sourcePath }
            }
            : {
              type: "volume.backup",
              hostId: current.host_id,
              payload: { backupId: backup.id, volumeName: prepared.volumeName }
            },
          current.created_by
        );
        return { backup, job };
      });

      if (!scheduled) continue;
      await notifyJobQueued(scheduled.job.id);
    } catch (error) {
      console.error("Backup schedule failed", row.id, error);
      await recordBackupScheduleResult(row.id, "failed", error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
    }
  }
}
