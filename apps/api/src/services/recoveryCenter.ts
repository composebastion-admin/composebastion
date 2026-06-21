import { v4 as uuid } from "uuid";
import type {
  MigrationExecuteRequest,
  MigrationPlanRequest,
  RecoveryPointDetail,
  RecoveryRestoreRequest
} from "@composebastion/shared";
import {
  backupTargetCreateSchema,
  backupTargetUpdateSchema,
  recoveryAppIdentitySchema,
  recoveryPointCreateSchema,
  recoveryPointListQuerySchema,
  recoveryScheduleCreateSchema
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import type pg from "pg";
import { enqueueJob } from "./jobs.js";
import {
  assertBackupTargetS3EndpointAllowed,
  exportBackupTargetSecrets,
  loadWorkerBackupTarget,
  mapBackupTargetFields,
  normalizeBackupTargetCreate,
  normalizeBackupTargetUpdate,
  toWorkerBackupTarget
} from "./recoveryBackupTargets.js";
import { testRcloneTarget } from "./recoveryRclone.js";
import { getRecoveryProfile } from "./recoveryProfiles.js";
import {
  mapMigrationRun,
  mapRecoveryArtifact,
  mapRecoveryPoint,
  mapRecoverySchedule
} from "./mappers.js";
import { resolveAppContext } from "./recoveryAppContext.js";
import { runRecoveryCreate, runRecoveryPointCapture, runRecoveryVerify } from "./recoveryCapture.js";
import { analyzeMigrationPlan, buildMigrationPlan } from "./migrationPlanning.js";
import { sanitizeArtifactName } from "./recoveryManifest.js";
import { deleteRecoveryPointRemoteArtifacts } from "./recoveryArtifactDelete.js";
import { artifactRelativePath, deleteRecoveryPointLocalFiles } from "./recoveryStorage.js";
import { safeErrorMessage, safeLogValue } from "./operationLogs.js";

export { resolveAppContext, buildMigrationPlan };
export { runRecoveryCreate, runRecoveryPointCapture, runRecoveryVerify };
export { runRecoveryRestore } from "./recoveryRestore.js";
export { runMigrationExecute } from "./migrationExecute.js";

export async function listBackupTargets() {
  const result = await query("SELECT * FROM backup_targets ORDER BY name ASC");
  return result.rows.map((row) => mapBackupTargetFields(row as Parameters<typeof mapBackupTargetFields>[0]));
}

export async function getBackupTarget(id: string) {
  const result = await query("SELECT * FROM backup_targets WHERE id = $1", [id]);
  return result.rows[0] ? mapBackupTargetFields(result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]) : null;
}

export async function getBackupTargetForWorker(id: string) {
  const result = await query<any>("SELECT * FROM backup_targets WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Backup target not found");
  return toWorkerBackupTarget(row);
}

export { exportBackupTargetSecrets };

export async function createBackupTarget(input: unknown, createdBy?: string | null) {
  const body = normalizeBackupTargetCreate(backupTargetCreateSchema.parse(input));
  await assertBackupTargetS3EndpointAllowed(body);
  const id = uuid();
  const result = await query(
    `INSERT INTO backup_targets (
       id, name, kind, enabled, config, access_key_id, secret_access_key_encrypted,
       provider, remote_path, local_cache_policy, generic_config_encrypted,
       generic_credentials_encrypted, health_status, created_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'unknown', $13)
     RETURNING *`,
    [
      id,
      body.name,
      body.kind,
      body.enabled,
      body.config,
      body.accessKeyId,
      body.secretAccessKeyEncrypted,
      body.provider,
      body.remotePath,
      body.localCachePolicy,
      body.genericConfigEncrypted,
      body.genericCredentialsEncrypted,
      createdBy ?? null
    ]
  );
  return mapBackupTargetFields(result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]);
}

export async function updateBackupTarget(id: string, input: unknown) {
  const existing = await getBackupTarget(id);
  if (!existing) return null;
  const current = await query<any>("SELECT * FROM backup_targets WHERE id = $1", [id]);
  const row = current.rows[0];
  const patch = normalizeBackupTargetUpdate(row, backupTargetUpdateSchema.parse(input));
  await assertBackupTargetS3EndpointAllowed({
    kind: row.kind,
    config: patch.config ?? row.config
  });
  const result = await query(
    `UPDATE backup_targets
     SET name = COALESCE($2, name),
         enabled = COALESCE($3, enabled),
         config = COALESCE($4, config),
         access_key_id = COALESCE($5, access_key_id),
         secret_access_key_encrypted = $6,
         provider = COALESCE($7, provider),
         remote_path = COALESCE($8, remote_path),
         local_cache_policy = COALESCE($9, local_cache_policy),
         generic_config_encrypted = $10,
         generic_credentials_encrypted = $11,
         health_status = CASE
           WHEN $4 IS NOT NULL OR $7 IS NOT NULL OR $8 IS NOT NULL OR $10 IS DISTINCT FROM generic_config_encrypted OR $11 IS DISTINCT FROM generic_credentials_encrypted
             THEN 'unknown'
           ELSE health_status
         END,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.enabled ?? null,
      patch.config ?? null,
      patch.accessKeyId === undefined ? null : patch.accessKeyId,
      patch.secretAccessKeyEncrypted !== undefined ? patch.secretAccessKeyEncrypted : row.secret_access_key_encrypted,
      patch.provider === undefined ? null : patch.provider,
      patch.remotePath === undefined ? null : patch.remotePath,
      patch.localCachePolicy ?? null,
      patch.genericConfigEncrypted !== undefined ? patch.genericConfigEncrypted : row.generic_config_encrypted,
      patch.genericCredentialsEncrypted !== undefined ? patch.genericCredentialsEncrypted : row.generic_credentials_encrypted
    ]
  );
  return mapBackupTargetFields(result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]);
}

export async function testBackupTarget(id: string) {
  const target = await loadWorkerBackupTarget(id);
  const checkedAt = new Date();
  try {
    if (!target.enabled) throw new Error("Backup target is disabled");
    if (target.kind === "s3") {
      await assertBackupTargetS3EndpointAllowed(target);
    } else if (target.kind === "rclone") {
      await testRcloneTarget(target);
    } else if (target.kind === "local") {
      // Local targets are validated by path safety and write attempts during capture.
    } else {
      throw new Error(`Unsupported backup target kind: ${(target as { kind: string }).kind}`);
    }
    const result = await query(
      `UPDATE backup_targets
       SET health_status = 'healthy',
           health_checked_at = $2,
           health_error = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, checkedAt]
    );
    return { target: mapBackupTargetFields(result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]), ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = await query(
      `UPDATE backup_targets
       SET health_status = 'failed',
           health_checked_at = $2,
           health_error = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, checkedAt, message]
    );
    return { target: mapBackupTargetFields(result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]), ok: false, error: message };
  }
}

export async function deleteBackupTarget(id: string) {
  const target = await getBackupTarget(id);
  if (!target) return null;
  await query("DELETE FROM backup_targets WHERE id = $1", [id]);
  return target;
}

export async function listRecoveryPoints(input?: unknown) {
  const queryInput = recoveryPointListQuerySchema.parse(input ?? {});
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (queryInput.hostId) {
    values.push(queryInput.hostId);
    clauses.push(`host_id = $${values.length}`);
  }
  if (queryInput.status) {
    values.push(queryInput.status);
    clauses.push(`status = $${values.length}`);
  }
  if (queryInput.appKind) {
    values.push(queryInput.appKind);
    clauses.push(`app_identity->>'kind' = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(`SELECT * FROM recovery_points ${where} ORDER BY created_at DESC`, values);
  return result.rows.map(mapRecoveryPoint);
}

export async function getRecoveryPoint(id: string): Promise<RecoveryPointDetail | null> {
  const result = await query("SELECT * FROM recovery_points WHERE id = $1", [id]);
  if (!result.rows[0]) return null;
  const artifacts = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [id]
  );
  return {
    ...mapRecoveryPoint(result.rows[0]),
    artifacts: artifacts.rows.map(mapRecoveryArtifact)
  };
}

async function insertArtifact(
  client: pg.PoolClient,
  recoveryPointId: string,
  kind: string,
  backupTargetId: string | null,
  storageKey: string,
  metadata: Record<string, unknown>
) {
  const id = uuid();
  await client.query(
    `INSERT INTO recovery_artifacts
      (id, recovery_point_id, kind, backup_target_id, storage_key, status, metadata)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
    [id, recoveryPointId, kind, backupTargetId, storageKey, metadata]
  );
  return id;
}

export async function createRecoveryPoint(
  input: unknown,
  createdBy?: string | null,
  internalMetadata: { scheduleId?: string; retentionCount?: number | null } = {}
) {
  const body = recoveryPointCreateSchema.parse(input);
  const context = await resolveAppContext(body.hostId, body.appIdentity);
  const profile = body.profileId ? await getRecoveryProfile(body.profileId) : null;
  const effectiveCaptureMode = body.captureMode === "stop_first" || profile?.captureMode === "stop_first"
    ? "stop_first"
    : "hot";
  const id = uuid();
  const name = body.name ?? `${context.label} ${new Date().toISOString()}`;
  const scheduleMetadata = internalMetadata.scheduleId
    ? {
      scheduleId: internalMetadata.scheduleId,
      retentionCount: internalMetadata.retentionCount ?? null
    }
    : {};

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO recovery_points
        (id, host_id, name, app_identity, trigger_kind, status, backup_target_id, profile_id, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9)`,
      [
        id,
        body.hostId,
        name,
        body.appIdentity,
        body.triggerKind,
        body.backupTargetId ?? null,
        body.profileId ?? null,
        {
          projectName: context.projectName,
          stackId: context.stackId,
          stopFirst: body.stopFirst || effectiveCaptureMode === "stop_first",
          captureMode: effectiveCaptureMode,
          extraIncludePaths: body.extraIncludePaths,
          profileId: body.profileId ?? null,
          profileSnapshot: profile ?? null,
          ...scheduleMetadata
        },
        createdBy ?? null
      ]
    );

    await insertArtifact(
      client,
      id,
      "metadata",
      body.backupTargetId ?? null,
      "manifest.json",
      { appIdentity: body.appIdentity, context }
    );
    let artifactCount = 1;

    if (context.composeYaml) {
      await insertArtifact(
        client,
        id,
        "compose_yaml",
        body.backupTargetId ?? null,
        "compose.yml",
        { projectName: context.projectName }
      );
      artifactCount += 1;
    }
    if (context.env) {
      await insertArtifact(
        client,
        id,
        "env_file",
        body.backupTargetId ?? null,
        ".env",
        { projectName: context.projectName }
      );
      artifactCount += 1;
    }
    for (const volumeName of context.volumeNames) {
      await insertArtifact(
        client,
        id,
        "volume",
        body.backupTargetId ?? null,
        artifactRelativePath("volume", sanitizeArtifactName(volumeName)),
        { volumeName }
      );
      artifactCount += 1;
    }

    await client.query("UPDATE recovery_points SET artifact_count = $2 WHERE id = $1", [id, artifactCount]);
  });

  const point = await getRecoveryPoint(id);
  if (!point) throw new Error("Failed to create recovery point");
  return point;
}

export async function deleteRecoveryPoint(id: string) {
  const point = await getRecoveryPoint(id);
  if (!point) return null;
  await deleteRecoveryPointRemoteArtifacts(point);
  await deleteRecoveryPointLocalFiles(id);
  await query("DELETE FROM recovery_points WHERE id = $1", [id]);
  return point;
}

export async function listRecoverySchedules() {
  const result = await query("SELECT * FROM recovery_schedules ORDER BY next_run_at ASC");
  return result.rows.map(mapRecoverySchedule);
}

export async function createRecoverySchedule(input: unknown, createdBy?: string | null) {
  const body = recoveryScheduleCreateSchema.parse(input);
  const id = uuid();
  const nextRunAt = new Date(Date.now() + body.intervalMs);
  const result = await query(
    `INSERT INTO recovery_schedules
      (id, host_id, name, app_identity, backup_target_id, profile_id, interval_ms, retention_count, next_run_at, enabled, capture_mode, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      body.hostId,
      body.name,
      body.appIdentity,
      body.backupTargetId ?? null,
      body.profileId ?? null,
      body.intervalMs,
      body.retentionCount ?? null,
      nextRunAt,
      body.enabled,
      body.captureMode,
      createdBy ?? null
    ]
  );
  return mapRecoverySchedule(result.rows[0]);
}

export async function deleteRecoverySchedule(id: string) {
  await query("DELETE FROM recovery_schedules WHERE id = $1", [id]);
}

export async function runDueRecoverySchedules() {
  const due = await query(
    `SELECT * FROM recovery_schedules
     WHERE enabled = true AND next_run_at <= now()
     ORDER BY next_run_at ASC
     LIMIT 20`
  );

  for (const row of due.rows) {
    try {
      const schedule = await withTransaction(async (client) => {
        const locked = await client.query("SELECT * FROM recovery_schedules WHERE id = $1 FOR UPDATE", [row.id]);
        const current = locked.rows[0];
        if (!current || !current.enabled || new Date(current.next_run_at) > new Date()) return null;
        const nextRunAt = new Date(Date.now() + Number(current.interval_ms));
        await client.query(
          `UPDATE recovery_schedules
           SET last_run_at = now(), next_run_at = $2, updated_at = now()
           WHERE id = $1`,
          [current.id, nextRunAt]
        );
        return current;
      });

      if (!schedule) continue;

      const point = await createRecoveryPoint({
        hostId: schedule.host_id,
        name: `${schedule.name} ${new Date().toISOString()}`,
        appIdentity: recoveryAppIdentitySchema.parse(schedule.app_identity),
        backupTargetId: schedule.backup_target_id ?? undefined,
        profileId: schedule.profile_id ?? undefined,
        triggerKind: "scheduled",
        stopFirst: schedule.capture_mode === "stop_first"
      }, schedule.created_by, {
        scheduleId: schedule.id,
        retentionCount: schedule.retention_count ?? null
      });

      await enqueueJob(
        {
          type: "recovery.create",
          hostId: schedule.host_id,
          payload: {
            recoveryPointId: point.id,
            stopFirst: Boolean(point.metadata.stopFirst)
          }
        },
        schedule.created_by
      );
    } catch (error) {
      console.error("Recovery schedule failed", {
        scheduleId: safeLogValue(row.id),
        error: safeErrorMessage(error)
      });
    }
  }
}

export async function createMigrationPlan(input: MigrationPlanRequest, createdBy?: string | null) {
  const context = await resolveAppContext(input.sourceHostId, input.sourceAppIdentity);
  const plan = await analyzeMigrationPlan(input, context);
  const id = uuid();
  const result = await query(
    `INSERT INTO migration_runs
      (id, source_host_id, target_host_id, source_app_identity, mode, status, plan, created_by, started_at, completed_at)
     VALUES ($1, $2, $3, $4, 'plan', 'completed', $5, $6, now(), now())
     RETURNING *`,
    [id, input.sourceHostId, input.targetHostId, input.sourceAppIdentity, plan, createdBy ?? null]
  );
  return mapMigrationRun(result.rows[0]);
}

export async function getMigrationRun(id: string) {
  const result = await query("SELECT * FROM migration_runs WHERE id = $1", [id]);
  return result.rows[0] ? mapMigrationRun(result.rows[0]) : null;
}

export async function listMigrationRuns() {
  const result = await query("SELECT * FROM migration_runs ORDER BY created_at DESC");
  return result.rows.map(mapMigrationRun);
}

export async function startMigrationExecute(input: MigrationExecuteRequest, createdBy?: string | null) {
  const id = uuid();
  const result = await query(
    `INSERT INTO migration_runs
      (id, source_host_id, target_host_id, source_app_identity, mode, status, recovery_point_id, created_by)
     VALUES ($1, $2, $3, $4, 'execute', 'queued', $5, $6)
     RETURNING *`,
    [
      id,
      input.sourceHostId,
      input.targetHostId,
      input.sourceAppIdentity,
      input.recoveryPointId ?? null,
      createdBy ?? null
    ]
  );
  const run = mapMigrationRun(result.rows[0]);
  const job = await enqueueJob(
    {
      type: "migration.execute",
      hostId: input.sourceHostId,
      payload: {
        migrationRunId: run.id,
        strategy: input.strategy,
        stopSource: input.options.stopSource,
        projectNameOverride: input.options.projectNameOverride,
        remapPorts: input.options.remapPorts,
        networkMode: input.options.networkMode
      }
    },
    createdBy ?? undefined
  );
  return { run, job };
}

export async function enqueueRecoveryCreate(recoveryPointId: string, hostId: string, createdBy?: string | null, stopFirst = false) {
  return enqueueJob({ type: "recovery.create", hostId, payload: { recoveryPointId, stopFirst } }, createdBy ?? undefined);
}

/** @deprecated Use enqueueRecoveryCreate */
export async function enqueueRecoveryCapture(recoveryPointId: string, hostId: string, createdBy?: string | null) {
  return enqueueRecoveryCreate(recoveryPointId, hostId, createdBy);
}

export async function enqueueRecoveryVerify(recoveryPointId: string, hostId: string, createdBy?: string | null) {
  return enqueueJob({ type: "recovery.verify", hostId, payload: { recoveryPointId } }, createdBy ?? undefined);
}

export async function enqueueRecoveryRestore(input: RecoveryRestoreRequest, createdBy?: string | null) {
  return enqueueJob(
    {
      type: "recovery.restore",
      hostId: input.targetHostId,
      payload: {
        recoveryPointId: input.recoveryPointId,
        mode: input.options.mode,
        stopExisting: input.options.stopExisting,
        projectNameOverride: input.options.projectNameOverride,
        volumePrefix: input.options.volumePrefix,
        restoreRoot: input.options.restoreRoot,
        remapPorts: input.options.remapPorts,
        networkMode: input.options.networkMode,
        drill: false
      }
    },
    createdBy ?? undefined
  );
}

export async function enqueueRecoveryDrill(recoveryPointId: string, createdBy?: string | null) {
  const point = await getRecoveryPoint(recoveryPointId);
  if (!point) return null;
  await query(
    `UPDATE recovery_points
     SET last_drill_at = now(),
         last_drill_status = 'queued',
         last_drill_error = null
     WHERE id = $1`,
    [point.id]
  );
  if (typeof point.metadata.scheduleId === "string") {
    await query(
      `UPDATE recovery_schedules
       SET last_drill_at = now(),
           last_drill_status = 'queued',
           last_drill_error = null,
           updated_at = now()
       WHERE id = $1`,
      [point.metadata.scheduleId]
    );
  }
  const job = await enqueueJob(
    {
      type: "recovery.restore",
      hostId: point.hostId,
      payload: {
        recoveryPointId: point.id,
        mode: "clone",
        stopExisting: false,
        remapPorts: true,
        networkMode: "clone",
        drill: true
      }
    },
    createdBy ?? undefined
  );
  return { point, job };
}

export async function markRecoveryDrillResult(recoveryPointId: string, status: "completed" | "failed", error?: string | null) {
  const successSql = status === "completed" ? ", last_successful_drill_at = now()" : "";
  await query(
    `UPDATE recovery_points
     SET last_drill_at = now(),
         last_drill_status = $2,
         last_drill_error = $3
         ${successSql}
     WHERE id = $1`,
    [recoveryPointId, status, error ?? null]
  );
  const point = await getRecoveryPoint(recoveryPointId);
  const scheduleId = point?.metadata.scheduleId;
  if (typeof scheduleId !== "string") return;
  await query(
    `UPDATE recovery_schedules
     SET last_drill_at = now(),
         last_drill_status = $2,
         last_drill_error = $3,
         updated_at = now()
         ${successSql}
     WHERE id = $1`,
    [scheduleId, status, error ?? null]
  );
}
