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
import { enqueueJob, enqueueJobInTransaction, notifyJobQueued, type JobExecutionFence } from "./jobs.js";
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
import {
  analyzeMigrationPlan,
  buildMigrationPlan,
  MigrationPlanStaleError,
  recoveryAppIdentitiesEqual,
  revalidateMigrationPlan,
  refreshMigrationInventories
} from "./migrationPlanning.js";
import { sanitizeArtifactName } from "./recoveryManifest.js";
import { deleteRecoveryPointRemoteArtifacts } from "./recoveryArtifactDelete.js";
import { artifactRelativePath, deleteRecoveryPointLocalFiles } from "./recoveryStorage.js";
import { safeErrorMessage, safeLogValue } from "./operationLogs.js";

export { resolveAppContext, buildMigrationPlan };
export { MigrationPlanStaleError } from "./migrationPlanning.js";
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

type PreparedRecoveryPoint = {
  id: string;
  body: ReturnType<typeof recoveryPointCreateSchema.parse>;
  context: Awaited<ReturnType<typeof resolveAppContext>>;
  profile: Awaited<ReturnType<typeof getRecoveryProfile>>;
  effectiveCaptureMode: "hot" | "stop_first";
  name: string;
  scheduleMetadata: { scheduleId: string; retentionCount: number | null } | Record<string, never>;
  createdBy: string | null;
};

async function prepareRecoveryPoint(
  input: unknown,
  createdBy?: string | null,
  internalMetadata: { scheduleId?: string; retentionCount?: number | null } = {}
): Promise<PreparedRecoveryPoint> {
  const body = recoveryPointCreateSchema.parse(input);
  const context = await resolveAppContext(body.hostId, body.appIdentity);
  const profile = body.profileId ? await getRecoveryProfile(body.profileId) : null;
  const effectiveCaptureMode = body.captureMode === "stop_first" || profile?.captureMode === "stop_first"
    ? "stop_first"
    : "hot";
  const id = uuid();
  const name = body.name ?? `${context.label} ${new Date().toISOString()}`;
  const scheduleMetadata: PreparedRecoveryPoint["scheduleMetadata"] = internalMetadata.scheduleId
    ? {
      scheduleId: internalMetadata.scheduleId,
      retentionCount: internalMetadata.retentionCount ?? null
    }
    : {};

  return { id, body, context, profile, effectiveCaptureMode, name, scheduleMetadata, createdBy: createdBy ?? null };
}

async function insertPreparedRecoveryPoint(
  client: pg.PoolClient,
  prepared: PreparedRecoveryPoint,
  migrationRunId: string | null = null
) {
  const { id, body, context, profile, effectiveCaptureMode, name, scheduleMetadata, createdBy } = prepared;
  const stopFirst = body.stopFirst || effectiveCaptureMode === "stop_first";
  await client.query(
    `INSERT INTO recovery_points
      (id, host_id, name, app_identity, trigger_kind, status, backup_target_id, profile_id, metadata, created_by, migration_run_id)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10)`,
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
        stopFirst,
        captureMode: effectiveCaptureMode,
        extraIncludePaths: body.extraIncludePaths,
        profileId: body.profileId ?? null,
        profileSnapshot: profile ?? null,
        ...scheduleMetadata
      },
      createdBy,
      migrationRunId
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
  return { id, hostId: body.hostId, stopFirst };
}

async function requireCreatedRecoveryPoint(id: string) {
  const point = await getRecoveryPoint(id);
  if (!point) throw new Error("Failed to create recovery point");
  return point;
}

export async function createRecoveryPoint(
  input: unknown,
  createdBy?: string | null,
  internalMetadata: { scheduleId?: string; retentionCount?: number | null } = {}
) {
  const prepared = await prepareRecoveryPoint(input, createdBy, internalMetadata);
  await withTransaction((client) => insertPreparedRecoveryPoint(client, prepared));
  return requireCreatedRecoveryPoint(prepared.id);
}

export async function createMigrationRecoveryPoint(
  input: unknown,
  migrationRunId: string,
  options: { primary?: boolean; executionFence?: JobExecutionFence } = {}
) {
  const prepared = await prepareRecoveryPoint(input);
  const insert = async (client: pg.PoolClient) => {
    const migration = await client.query<{
      source_host_id: string;
      source_app_identity: unknown;
      mode: string;
      status: string;
    }>(
      `SELECT source_host_id, source_app_identity, mode, status
       FROM migration_runs
       WHERE id = $1
       FOR UPDATE`,
      [migrationRunId]
    );
    const run = migration.rows[0];
    if (
      !run
      || run.mode !== "execute"
      || run.status !== "running"
      || run.source_host_id !== prepared.body.hostId
      || !recoveryAppIdentitiesEqual(
        recoveryAppIdentitySchema.parse(run.source_app_identity),
        prepared.body.appIdentity
      )
    ) {
      throw new MigrationPlanStaleError("Migration recovery point no longer matches the active reviewed execution.");
    }

    const created = await insertPreparedRecoveryPoint(client, prepared, migrationRunId);
    if (options.primary) {
      const linked = await client.query(
        `UPDATE migration_runs
         SET recovery_point_id = $2
         WHERE id = $1 AND mode = 'execute' AND status = 'running'
         RETURNING id`,
        [migrationRunId, created.id]
      );
      if (linked.rowCount !== 1) {
        throw new MigrationPlanStaleError("Migration execution is no longer active.");
      }
    }
    return created;
  };

  return options.executionFence
    ? options.executionFence.withActiveLease(insert)
    : withTransaction(insert);
}

export async function getMigrationRecoveryPoint(id: string, migrationRunId: string): Promise<RecoveryPointDetail | null> {
  const result = await query(
    `SELECT recovery_point.*
     FROM recovery_points AS recovery_point
     JOIN migration_runs AS migration_run ON migration_run.id = $2
     WHERE recovery_point.id = $1
       AND (
         recovery_point.migration_run_id = migration_run.id
         OR (
           recovery_point.migration_run_id IS NULL
           AND migration_run.recovery_point_id = recovery_point.id
         )
       )`,
    [id, migrationRunId]
  );
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

export async function createRecoveryPointWithJob(input: unknown, createdBy?: string | null) {
  const prepared = await prepareRecoveryPoint(input, createdBy);
  const result = await withTransaction(async (client) => {
    const created = await insertPreparedRecoveryPoint(client, prepared);
    const job = await enqueueJobInTransaction(
      client,
      {
        type: "recovery.create",
        hostId: created.hostId,
        payload: { recoveryPointId: created.id, stopFirst: created.stopFirst }
      },
      createdBy ?? undefined
    );
    return { job, recoveryPointId: created.id };
  });
  await notifyJobQueued(result.job.id);
  return { point: await requireCreatedRecoveryPoint(result.recoveryPointId), job: result.job };
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
      const prepared = await prepareRecoveryPoint({
        hostId: row.host_id,
        name: `${row.name} ${new Date().toISOString()}`,
        appIdentity: recoveryAppIdentitySchema.parse(row.app_identity),
        backupTargetId: row.backup_target_id ?? undefined,
        profileId: row.profile_id ?? undefined,
        triggerKind: "scheduled",
        stopFirst: row.capture_mode === "stop_first"
      }, row.created_by, {
        scheduleId: row.id,
        retentionCount: row.retention_count ?? null
      });
      const scheduled = await withTransaction(async (client) => {
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
        const created = await insertPreparedRecoveryPoint(client, prepared);
        const job = await enqueueJobInTransaction(
          client,
          {
            type: "recovery.create",
            hostId: created.hostId,
            payload: { recoveryPointId: created.id, stopFirst: created.stopFirst }
          },
          current.created_by
        );
        return { job };
      });

      if (!scheduled) continue;
      await notifyJobQueued(scheduled.job.id);
    } catch (error) {
      console.error("Recovery schedule failed", {
        scheduleId: safeLogValue(row.id),
        error: safeErrorMessage(error)
      });
    }
  }
}

export async function createMigrationPlan(input: MigrationPlanRequest, createdBy?: string | null) {
  // Planning should use current inventories. A failed refresh is represented by
  // the availability checks in the resulting plan instead of hiding the plan.
  await refreshMigrationInventories(input.sourceHostId, input.targetHostId).catch(() => undefined);
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
  let planRun;
  let recoveryPointId: string | undefined;
  if ("planRunId" in input) {
    planRun = await getMigrationRun(input.planRunId);
    recoveryPointId = undefined;
    if (!planRun) {
      throw new MigrationPlanStaleError("Migration plan was not found; create and review a new plan.");
    }
  } else {
    recoveryPointId = input.recoveryPointId;
    planRun = await createMigrationPlan({
      sourceHostId: input.sourceHostId,
      targetHostId: input.targetHostId,
      sourceAppIdentity: input.sourceAppIdentity,
      createRecoveryPoint: true,
      strategy: input.strategy,
      options: input.options
    }, createdBy);
  }

  const currentPlan = await revalidateMigrationPlan(planRun);
  if (!currentPlan.intent) {
    throw new MigrationPlanStaleError("Migration plan has no execution intent; create and review a new plan.");
  }
  const intent = currentPlan.intent;

  const id = uuid();
  const transactionResult = await withTransaction(async (client) => {
    const lockedPlan = await client.query(
      "SELECT id FROM migration_runs WHERE id = $1 AND mode = 'plan' AND status = 'completed' FOR UPDATE",
      [planRun.id]
    );
    if (!lockedPlan.rows[0]) {
      throw new MigrationPlanStaleError("Migration plan is unavailable; create and review a new plan.");
    }
    const alreadyUsed = await client.query(
      "SELECT id FROM migration_runs WHERE plan_run_id = $1 LIMIT 1",
      [planRun.id]
    );
    if (alreadyUsed.rows[0]) {
      throw new MigrationPlanStaleError("Migration plan has already been used; create and review a new plan.");
    }
    if (recoveryPointId) {
      const selectedPoint = await client.query<{
        host_id: string;
        app_identity: unknown;
        status: string;
        migration_run_id: string | null;
      }>(
        `SELECT host_id, app_identity, status, migration_run_id
         FROM recovery_points
         WHERE id = $1
         FOR UPDATE`,
        [recoveryPointId]
      );
      const point = selectedPoint.rows[0];
      if (
        !point
        || point.host_id !== planRun.sourceHostId
        || (point.status !== "completed" && point.status !== "partial")
        || point.migration_run_id !== null
        || !recoveryAppIdentitiesEqual(
          recoveryAppIdentitySchema.parse(point.app_identity),
          planRun.sourceAppIdentity
        )
      ) {
        throw new MigrationPlanStaleError(
          "Supplied recovery point is unavailable or does not match the reviewed source application."
        );
      }
    }
    const result = await client.query(
      `INSERT INTO migration_runs
        (id, plan_run_id, source_host_id, target_host_id, source_app_identity, mode, status,
         recovery_point_id, plan, created_by)
       VALUES ($1, $2, $3, $4, $5, 'execute', 'queued', $6, $7, $8)
       RETURNING *`,
      [
        id,
        planRun.id,
        planRun.sourceHostId,
        planRun.targetHostId,
        planRun.sourceAppIdentity,
        recoveryPointId ?? null,
        currentPlan,
        createdBy ?? null
      ]
    );
    const run = mapMigrationRun(result.rows[0]);
    const job = await enqueueJobInTransaction(
      client,
      {
        type: "migration.execute",
        hostId: run.sourceHostId,
        payload: {
          migrationRunId: run.id,
          strategy: intent.strategy,
          stopSource: intent.options.stopSource,
          projectNameOverride: intent.options.projectNameOverride,
          remapPorts: intent.options.remapPorts,
          networkMode: intent.options.networkMode
        }
      },
      createdBy ?? undefined
    );
    return { run, job };
  });
  await notifyJobQueued(transactionResult.job.id);
  return transactionResult;
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
  const queued = await withTransaction(async (client) => {
    const pointResult = await client.query(
      "SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE",
      [recoveryPointId]
    );
    const row = pointResult.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE recovery_points
       SET last_drill_at = now(),
           last_drill_status = 'queued',
           last_drill_error = null
       WHERE id = $1`,
      [recoveryPointId]
    );
    const scheduleId = row.metadata?.scheduleId;
    if (typeof scheduleId === "string") {
      await client.query(
      `UPDATE recovery_schedules
       SET last_drill_at = now(),
           last_drill_status = 'queued',
           last_drill_error = null,
           updated_at = now()
       WHERE id = $1`,
        [scheduleId]
      );
    }
    const job = await enqueueJobInTransaction(
      client,
      {
        type: "recovery.restore",
        hostId: row.host_id,
        payload: {
          recoveryPointId,
          mode: "clone",
          stopExisting: false,
          remapPorts: true,
          networkMode: "clone",
          drill: true
        }
      },
      createdBy ?? undefined
    );
    return { job };
  });
  if (!queued) return null;
  await notifyJobQueued(queued.job.id);
  return { point: await requireCreatedRecoveryPoint(recoveryPointId), job: queued.job };
}

export async function markRecoveryDrillResult(
  recoveryPointId: string,
  status: "completed" | "failed",
  error?: string | null,
  executionFence?: JobExecutionFence
) {
  const successSql = status === "completed" ? ", last_successful_drill_at = now()" : "";
  const update = async (client: pg.PoolClient) => {
    const point = await client.query<{ metadata: Record<string, unknown> }>(
      `UPDATE recovery_points
       SET last_drill_at = now(),
           last_drill_status = $2,
           last_drill_error = $3
           ${successSql}
       WHERE id = $1
       RETURNING metadata`,
      [recoveryPointId, status, error ?? null]
    );
    const scheduleId = point.rows[0]?.metadata?.scheduleId;
    if (typeof scheduleId !== "string") return;
    await client.query(
      `UPDATE recovery_schedules
       SET last_drill_at = now(),
           last_drill_status = $2,
           last_drill_error = $3,
           updated_at = now()
           ${successSql}
       WHERE id = $1`,
      [scheduleId, status, error ?? null]
    );
  };
  if (executionFence) {
    await executionFence.withActiveLease(update);
  } else {
    await withTransaction(update);
  }
}
