import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type {
  MigrationExecuteRequest,
  MigrationPlanRequest,
  DockerActionRequest,
  RecoveryPointDetail,
  RecoveryRestoreRequest
} from "@composebastion/shared";
import {
  backupTargetCreateSchema,
  backupTargetUpdateSchema,
  recoveryAppIdentitySchema,
  recoveryPointCreateSchema,
  recoveryPointListQuerySchema,
  recoveryScheduleCreateSchema,
  sanitizeUrlDiagnosticText
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import type pg from "pg";
import {
  assertBackupTargetHasNoRemoteArtifactOrphans,
  assertBackupTargetIdentityChangeAllowed,
  assertBackupTargetOrphanCleanupBindingChangeAllowed,
  assertBackupTargetUsableForReference,
  backupTargetReferenceConflict,
  getBackupTargetReferenceCounts,
  hasBackupTargetReferences,
  lockBackupTarget
} from "./backupTargetLifecycle.js";
import { enqueueJobInTransaction, notifyJobQueued, type JobExecutionFence } from "./jobs.js";
import {
  assertBackupTargetS3EndpointAllowed,
  exportBackupTargetSecrets,
  mapBackupTargetFields,
  normalizeBackupTargetCreate,
  normalizeBackupTargetUpdate,
  toWorkerBackupTarget,
  type WorkerBackupTarget
} from "./recoveryBackupTargets.js";
import {
  buildRemoteObjectKey,
  deleteRemoteArtifact,
  downloadRemoteArtifactAtomically,
  headRemoteArtifact,
  uploadRemoteArtifact
} from "./recoveryRemoteStorage.js";
import { getRecoveryProfile } from "./recoveryProfiles.js";
import {
  mapMigrationRun,
  mapRecoveryArtifact,
  recoveryArtifactEvidenceCounts,
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
import { recoveryPointHasDeletionClaim } from "./recoveryPointDelete.js";
import {
  buildRecoverySourceDockerMutationScope,
  buildRecoverySourceOperationScopeKeys,
  buildRecoveryTargetOperationScopeKeys,
  lockRecoveryOperationAdmission,
  MIGRATION_SOURCE_SCOPE_PLAN_KEY,
  MIGRATION_TARGET_SCOPE_PLAN_KEY,
  persistRecoveryDockerMutationScopes,
  RECOVERY_SOURCE_SCOPE_METADATA_KEY,
  type RecoveryAdmissionOperationKind
} from "./recoveryOperationAdmission.js";
import {
  loadRecoveryRestorePlan
} from "./recoveryRestorePlan.js";
import type { DockerMutationScope } from "./dockerMutationScope.js";
import {
  artifactRelativePath,
  recoveryPointsRootDir
} from "./recoveryStorage.js";
import { safeErrorMessage, safeLogValue } from "./operationLogs.js";
import {
  beginRemoteArtifactWriteIntent,
  clearRemoteArtifactWriteIntent,
  recordRemoteArtifactOrphan,
  REMOTE_ARTIFACT_WRITE_INTENT_HEARTBEAT_MS,
  renewRemoteArtifactWriteIntent,
  type RemoteArtifactWriteIntent
} from "./recoveryRemoteOrphans.js";

export { resolveAppContext, buildMigrationPlan };
export { MigrationPlanStaleError } from "./migrationPlanning.js";
export { runRecoveryCreate, runRecoveryPointCapture, runRecoveryVerify };
export {
  runRecoveryRestore,
  runRecoveryRestoreDrill,
  runRecoveryRestoreWithCleanup,
  validateRecoveryRestoreDrill
} from "./recoveryRestore.js";
export { runMigrationExecute } from "./migrationExecute.js";
export { deleteRecoveryPoint } from "./recoveryPointDelete.js";

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

export async function createBackupTarget(
  input: unknown,
  createdBy?: string | null,
  onCreated?: (
    client: pg.PoolClient,
    target: ReturnType<typeof mapBackupTargetFields>
  ) => Promise<void>
) {
  const body = normalizeBackupTargetCreate(backupTargetCreateSchema.parse(input));
  await assertBackupTargetS3EndpointAllowed(body);
  const id = uuid();
  return withTransaction(async (client) => {
    const result = await client.query(
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
    const target = mapBackupTargetFields(
      result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]
    );
    await onCreated?.(client, target);
    return target;
  });
}

export async function updateBackupTarget(
  id: string,
  input: unknown,
  onUpdated?: (
    client: pg.PoolClient,
    target: ReturnType<typeof mapBackupTargetFields>
  ) => Promise<void>
) {
  const body = backupTargetUpdateSchema.parse(input);
  return withTransaction(async (client) => {
    const locked = await lockBackupTarget(client, id);
    if (!locked) return null;
    const row = locked as any;
    const patch = normalizeBackupTargetUpdate(row, body);
    const nextIdentity = {
      kind: row.kind,
      config: patch.config ?? row.config,
      provider: patch.provider ?? row.provider,
      remote_path: patch.remotePath ?? row.remote_path,
      access_key_id: patch.accessKeyId === undefined
        ? row.access_key_id
        : patch.accessKeyId,
      secret_access_key_encrypted: patch.secretAccessKeyEncrypted === undefined
        ? row.secret_access_key_encrypted
        : patch.secretAccessKeyEncrypted,
      generic_config_encrypted: patch.genericConfigEncrypted !== undefined
        ? patch.genericConfigEncrypted
        : row.generic_config_encrypted,
      generic_credentials_encrypted: patch.genericCredentialsEncrypted !== undefined
        ? patch.genericCredentialsEncrypted
        : row.generic_credentials_encrypted
    };
    await assertBackupTargetS3EndpointAllowed(nextIdentity);
    await assertBackupTargetIdentityChangeAllowed(client, id, row, nextIdentity);
    await assertBackupTargetOrphanCleanupBindingChangeAllowed(
      client,
      id,
      row,
      nextIdentity
    );
    const nextEnabled = patch.enabled === undefined ? row.enabled : patch.enabled;
    const nextAccessKeyId = patch.accessKeyId === undefined
      ? row.access_key_id
      : patch.accessKeyId;
    const nextSecretAccessKey = patch.secretAccessKeyEncrypted === undefined
      ? row.secret_access_key_encrypted
      : patch.secretAccessKeyEncrypted;
    const changesS3CredentialState = patch.accessKeyId !== undefined
      || patch.secretAccessKeyEncrypted !== undefined
      || patch.enabled === true;
    if (
      row.kind === "s3"
      && changesS3CredentialState
      && nextEnabled
      && (!nextAccessKeyId || !nextSecretAccessKey)
    ) {
      throw Object.assign(
        new Error("Enabled S3 backup targets require both access-key credentials"),
        { statusCode: 400 }
      );
    }
    const result = await client.query(
      `UPDATE backup_targets
       SET name = COALESCE($2, name),
           enabled = COALESCE($3, enabled),
           config = COALESCE($4, config),
           access_key_id = $5,
           secret_access_key_encrypted = $6,
           provider = COALESCE($7, provider),
           remote_path = COALESCE($8, remote_path),
           local_cache_policy = COALESCE($9, local_cache_policy),
           generic_config_encrypted = $10,
           generic_credentials_encrypted = $11,
           health_status = CASE
             WHEN ($4 IS NOT NULL AND $4 IS DISTINCT FROM config)
               OR $5 IS DISTINCT FROM access_key_id
               OR $6 IS DISTINCT FROM secret_access_key_encrypted
               OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM provider)
               OR ($8 IS NOT NULL AND $8 IS DISTINCT FROM remote_path)
               OR $10 IS DISTINCT FROM generic_config_encrypted
               OR $11 IS DISTINCT FROM generic_credentials_encrypted
               THEN 'unknown'
             ELSE health_status
           END,
           health_checked_at = CASE
             WHEN ($4 IS NOT NULL AND $4 IS DISTINCT FROM config)
               OR $5 IS DISTINCT FROM access_key_id
               OR $6 IS DISTINCT FROM secret_access_key_encrypted
               OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM provider)
               OR ($8 IS NOT NULL AND $8 IS DISTINCT FROM remote_path)
               OR $10 IS DISTINCT FROM generic_config_encrypted
               OR $11 IS DISTINCT FROM generic_credentials_encrypted
               THEN NULL
             ELSE health_checked_at
           END,
           health_error = CASE
             WHEN ($4 IS NOT NULL AND $4 IS DISTINCT FROM config)
               OR $5 IS DISTINCT FROM access_key_id
               OR $6 IS DISTINCT FROM secret_access_key_encrypted
               OR ($7 IS NOT NULL AND $7 IS DISTINCT FROM provider)
               OR ($8 IS NOT NULL AND $8 IS DISTINCT FROM remote_path)
               OR $10 IS DISTINCT FROM generic_config_encrypted
               OR $11 IS DISTINCT FROM generic_credentials_encrypted
               THEN NULL
             ELSE health_error
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.enabled ?? null,
        patch.config ?? null,
        nextAccessKeyId,
        patch.secretAccessKeyEncrypted !== undefined ? patch.secretAccessKeyEncrypted : row.secret_access_key_encrypted,
        patch.provider === undefined ? null : patch.provider,
        patch.remotePath === undefined ? null : patch.remotePath,
        patch.localCachePolicy ?? null,
        patch.genericConfigEncrypted !== undefined ? patch.genericConfigEncrypted : row.generic_config_encrypted,
        patch.genericCredentialsEncrypted !== undefined ? patch.genericCredentialsEncrypted : row.generic_credentials_encrypted
      ]
    );
    const target = mapBackupTargetFields(
      result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]
    );
    await onUpdated?.(client, target);
    return target;
  });
}

async function probeRemoteBackupTarget(target: WorkerBackupTarget) {
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error(`Remote backup target probe cannot use ${target.kind}`);
  }
  const backend = target.kind;
  const payload = Buffer.from("ComposeBastion backup target health probe\n", "utf8");
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "composebastion-target-test-"));
  const localPath = path.join(tempDirectory, "probe.txt");
  const downloadedPath = path.join(tempDirectory, "downloaded-probe.txt");
  const namespaceId = `target-tests/${target.id}`;
  const storageKey = `${uuid()}.probe`;
  const objectKey = buildRemoteObjectKey(target, namespaceId, storageKey);
  const attemptToken = uuid();
  let uploadAttempted = false;
  let uploadedObjectKey: string | null = null;
  let writeIntent: RemoteArtifactWriteIntent | null = null;
  let writeIntentHeartbeat: NodeJS.Timeout | null = null;
  let primaryError: unknown;
  try {
    await writeFile(localPath, payload, { flag: "wx", mode: 0o600 });
    writeIntent = await beginRemoteArtifactWriteIntent({
      ownerKind: "backup_target_probe",
      ownerId: target.id,
      backupTargetId: target.id,
      objectKey,
      backend,
      attemptToken,
      target
    });
    writeIntentHeartbeat = setInterval(() => {
      if (!writeIntent) return;
      void renewRemoteArtifactWriteIntent(writeIntent).catch((error) => {
        console.warn("Failed to renew a remote backup target probe write intent", {
          backupTargetId: target.id,
          error: safeErrorMessage(error)
        });
      });
    }, REMOTE_ARTIFACT_WRITE_INTENT_HEARTBEAT_MS);
    writeIntentHeartbeat.unref();
    uploadAttempted = true;
    const uploaded = await uploadRemoteArtifact({
      target,
      namespaceId,
      storageKey,
      localPath
    });
    if (uploaded && typeof uploaded.remoteObjectKey === "string" && uploaded.remoteObjectKey) {
      uploadedObjectKey = uploaded.remoteObjectKey;
    }
    if (!uploaded || uploaded.remoteBackend !== backend || uploaded.remoteObjectKey !== objectKey) {
      throw new Error("Remote backup target did not return the expected probe object");
    }
    const head = await headRemoteArtifact(target, objectKey);
    if (head.sizeBytes !== payload.byteLength) {
      throw new Error("Remote backup target probe metadata did not match the uploaded object");
    }
    await downloadRemoteArtifactAtomically(target, objectKey, downloadedPath);
    const downloaded = await readFile(downloadedPath);
    if (!downloaded.equals(payload)) {
      throw new Error("Remote backup target probe download did not match the uploaded content");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (uploadAttempted) {
      const cleanupKeys = [...new Set([uploadedObjectKey, objectKey].filter(
        (key): key is string => typeof key === "string" && key.length > 0
      ))];
      for (const cleanupKey of cleanupKeys) {
        try {
          await deleteRemoteArtifact(target, cleanupKey);
          if (writeIntent && cleanupKey === writeIntent.objectKey) {
            await clearRemoteArtifactWriteIntent(writeIntent);
            writeIntent = null;
          }
        } catch (error) {
          let durableCleanupError: unknown;
          try {
            await recordRemoteArtifactOrphan({
              ownerKind: "backup_target_probe",
              ownerId: target.id,
              backupTargetId: target.id,
              objectKey: cleanupKey,
              backend,
              attemptToken,
              target,
              cleanupError: error
            });
          } catch (ledgerError) {
            durableCleanupError = ledgerError;
          }
          cleanupErrors.push(
            durableCleanupError
              ? new AggregateError(
                  [error, durableCleanupError],
                  `Remote backup target probe object cleanup and durable orphan recording both failed for ${cleanupKey}`
                )
              : new Error(
                  `Remote backup target probe object cleanup failed for ${cleanupKey}: ${safeErrorMessage(error)}`
                )
          );
        }
      }
    }
    if (writeIntentHeartbeat) {
      clearInterval(writeIntentHeartbeat);
      writeIntentHeartbeat = null;
    }
    try {
      await rm(tempDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      const cleanupSummary = cleanupErrors.map((error) => safeErrorMessage(error)).join("; ");
      if (primaryError) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          `Remote backup target probe failed (${safeErrorMessage(primaryError)}) and cleanup failed (${cleanupSummary})`
        );
      }
      throw cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, `Remote backup target probe cleanup failed (${cleanupSummary})`);
    }
  }
}

async function probeLocalBackupTarget() {
  const root = path.resolve(recoveryPointsRootDir());
  await mkdir(root, { recursive: true });
  const probeDirectory = await mkdtemp(path.join(root, ".composebastion-target-test-"));
  const resolvedProbeDirectory = path.resolve(probeDirectory);
  if (!resolvedProbeDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error("Local backup target probe escaped the recovery storage directory");
  }
  const probePath = path.join(resolvedProbeDirectory, "probe.txt");
  const payload = Buffer.from("ComposeBastion local backup target health probe\n", "utf8");
  let primaryError: unknown;
  try {
    await writeFile(probePath, payload, { flag: "wx", mode: 0o600 });
    const readBack = await readFile(probePath);
    if (!readBack.equals(payload)) {
      throw new Error("Local backup target probe did not read back the written content");
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await rm(resolvedProbeDirectory, { recursive: true, force: true });
    } catch (error) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, error],
          `Local backup target probe failed (${safeErrorMessage(primaryError)}) and cleanup failed (${safeErrorMessage(error)})`
        );
      }
      throw error;
    }
  }
}

export async function testBackupTarget(
  id: string,
  onTesting?: (
    client: pg.PoolClient,
    target: ReturnType<typeof mapBackupTargetFields>
  ) => Promise<void>
) {
  const loadSnapshot = async (
    executeQuery: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: any[] }>
  ) => {
    const initial = await executeQuery(
      "SELECT *, xmin::text AS row_version FROM backup_targets WHERE id = $1",
      [id]
    );
    return initial.rows[0];
  };
  const snapshot = onTesting
    ? await withTransaction(async (client) => {
        const row = await loadSnapshot(
          (text, values) => client.query(text, values)
        );
        if (!row) {
          throw Object.assign(
            new Error("Backup target not found"),
            { statusCode: 404 }
          );
        }
        const target = mapBackupTargetFields(
          row as Parameters<
            typeof mapBackupTargetFields
          >[0]
        );
        await onTesting(client, target);
        return row;
      })
    : await loadSnapshot(query);
  if (!snapshot) {
    throw Object.assign(new Error("Backup target not found"), { statusCode: 404 });
  }
  const target = toWorkerBackupTarget(snapshot);
  const checkedAt = new Date();
  let ok = true;
  let message: string | null = null;
  try {
    if (!target.enabled) throw new Error("Backup target is disabled");
    if (target.kind === "s3") {
      await probeRemoteBackupTarget(target);
    } else if (target.kind === "rclone") {
      await probeRemoteBackupTarget(target);
    } else if (target.kind === "local") {
      await probeLocalBackupTarget();
    } else {
      throw new Error(`Unsupported backup target kind: ${(target as { kind: string }).kind}`);
    }
  } catch (error) {
    ok = false;
    message = String(sanitizeUrlDiagnosticText(safeErrorMessage(error)));
  }
  const persistResult = async (
    executeQuery: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: any[] }>
  ) => {
    const result = await executeQuery(
      `UPDATE backup_targets
       SET health_status = $3,
           health_checked_at = $2,
           health_error = $4,
           updated_at = now()
       WHERE id = $1
         AND xmin::text = $5
       RETURNING *`,
      [
        id,
        checkedAt,
        ok ? "healthy" : "failed",
        message,
        snapshot.row_version
      ]
    );
    if (!result.rows[0]) {
      throw Object.assign(
        new Error("Backup target changed or was deleted while the connection test was running; the stale health result was discarded."),
        { statusCode: 409 }
      );
    }
    const mapped = mapBackupTargetFields(
      result.rows[0] as Parameters<typeof mapBackupTargetFields>[0]
    );
    const tested = ok
      ? { target: mapped, ok: true as const }
      : {
          target: mapped,
          ok: false as const,
          error: message ?? "Backup target test failed"
        };
    return tested;
  };
  return persistResult(query);
}

export async function deleteBackupTarget(
  id: string,
  onDeleted?: (
    client: pg.PoolClient,
    target: ReturnType<typeof mapBackupTargetFields>
  ) => Promise<void>
) {
  return withTransaction(async (client) => {
    const locked = await lockBackupTarget(client, id);
    if (!locked) return null;
    await assertBackupTargetHasNoRemoteArtifactOrphans(client, id);
    const counts = await getBackupTargetReferenceCounts(client, id);
    if (hasBackupTargetReferences(counts)) {
      throw backupTargetReferenceConflict("delete", counts);
    }
    await client.query("DELETE FROM backup_targets WHERE id = $1", [id]);
    const target = mapBackupTargetFields(
      locked as Parameters<typeof mapBackupTargetFields>[0]
    );
    await onDeleted?.(client, target);
    return target;
  });
}

export async function listRecoveryPoints(input?: unknown) {
  const queryInput = recoveryPointListQuerySchema.parse(input ?? {});
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (queryInput.hostId) {
    values.push(queryInput.hostId);
    clauses.push(`rp.host_id = $${values.length}`);
  }
  if (queryInput.status) {
    values.push(queryInput.status);
    clauses.push(`rp.status = $${values.length}`);
  }
  if (queryInput.appKind) {
    values.push(queryInput.appKind);
    clauses.push(`rp.app_identity->>'kind' = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT rp.*,
            COALESCE(evidence.remote_artifact_count, 0) AS remote_artifact_count,
            COALESCE(evidence.remote_upload_failure_count, 0) AS remote_upload_failure_count,
            COALESCE(evidence.local_retained_artifact_count, 0) AS local_retained_artifact_count,
            COALESCE(evidence.local_removed_artifact_count, 0) AS local_removed_artifact_count
     FROM recovery_points rp
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) FILTER (
           WHERE NULLIF(artifact.metadata->>'remoteObjectKey', '') IS NOT NULL
         ) AS remote_artifact_count,
         COUNT(*) FILTER (
           WHERE artifact.metadata ? 'remoteUploadError'
              OR artifact.metadata ? 'remoteVerificationError'
         ) AS remote_upload_failure_count,
         COUNT(*) FILTER (
           WHERE artifact.status IN ('completed', 'partial')
             AND (
               (
                 artifact.metadata->>'localCacheRemoved' = 'false'
                 AND (
                   artifact.metadata->>'localCachePolicy' IS DISTINCT FROM 'remote_only'
                   OR artifact.metadata->>'localCacheCleanupAttempted' = 'true'
                   OR NULLIF(artifact.metadata->>'remoteObjectKey', '') IS NULL
                 )
               )
               OR (
                 artifact.metadata->>'localCacheRemoved' IS NULL
                 AND artifact.metadata->>'localCachePolicy' IS DISTINCT FROM 'remote_only'
               )
             )
         ) AS local_retained_artifact_count,
         COUNT(*) FILTER (
           WHERE artifact.metadata->>'localCacheRemoved' = 'true'
         ) AS local_removed_artifact_count
       FROM recovery_artifacts artifact
       WHERE artifact.recovery_point_id = rp.id
     ) evidence ON true
     ${where}
     ORDER BY rp.created_at DESC`,
    values
  );
  return result.rows.map(mapRecoveryPoint);
}

export async function getRecoveryPoint(id: string): Promise<RecoveryPointDetail | null> {
  const result = await query("SELECT * FROM recovery_points WHERE id = $1", [id]);
  if (!result.rows[0]) return null;
  const artifacts = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [id]
  );
  const mappedArtifacts = artifacts.rows.map(mapRecoveryArtifact);
  return {
    ...mapRecoveryPoint(result.rows[0]),
    ...recoveryArtifactEvidenceCounts(mappedArtifacts),
    artifacts: mappedArtifacts
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

function preparedRecoverySourceScopeKeys(prepared: PreparedRecoveryPoint) {
  return buildRecoverySourceOperationScopeKeys(
    prepared.body.hostId,
    prepared.body.appIdentity,
    prepared.context
  );
}

function preparedRecoverySourceDockerScope(
  prepared: PreparedRecoveryPoint
) {
  return buildRecoverySourceDockerMutationScope(
    prepared.body.hostId,
    prepared.body.appIdentity,
    prepared.context
  );
}

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
  const operationSourceScopeKeys = preparedRecoverySourceScopeKeys(prepared);
  await assertBackupTargetUsableForReference(client, body.backupTargetId);
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
        [RECOVERY_SOURCE_SCOPE_METADATA_KEY]: operationSourceScopeKeys,
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
  return { id, hostId: body.hostId, stopFirst, operationSourceScopeKeys };
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
  const mappedArtifacts = artifacts.rows.map(mapRecoveryArtifact);
  return {
    ...mapRecoveryPoint(result.rows[0]),
    ...recoveryArtifactEvidenceCounts(mappedArtifacts),
    artifacts: mappedArtifacts
  };
}

export async function createRecoveryPointWithJob(
  input: unknown,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: {
      recoveryPointId: string;
      hostId: string;
      appIdentity: PreparedRecoveryPoint["body"]["appIdentity"];
      job: Awaited<ReturnType<
        typeof enqueueJobInTransaction
      >>;
    }
  ) => Promise<void>
) {
  const prepared = await prepareRecoveryPoint(input, createdBy);
  const sourceDockerScope = preparedRecoverySourceDockerScope(prepared);
  const result = await withTransaction(async (client) => {
    await lockRecoveryOperationAdmission(client, {
      kind: "capture",
      recoveryPointId: prepared.id,
      sourceScopeKeys: preparedRecoverySourceScopeKeys(prepared),
      sourceDockerScopes: [sourceDockerScope]
    });
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
    await persistRecoveryDockerMutationScopes(client, job.id, {
      source: [sourceDockerScope]
    });
    const queued = {
      job,
      recoveryPointId: created.id,
      hostId: created.hostId,
      appIdentity: prepared.body.appIdentity
    };
    await onQueued?.(client, queued);
    return queued;
  });
  await notifyJobQueued(result.job.id);
  return { point: await requireCreatedRecoveryPoint(result.recoveryPointId), job: result.job };
}

export async function listRecoverySchedules() {
  const result = await query("SELECT * FROM recovery_schedules ORDER BY next_run_at ASC");
  return result.rows.map(mapRecoverySchedule);
}

export async function createRecoverySchedule(
  input: unknown,
  createdBy?: string | null,
  onCreated?: (
    client: pg.PoolClient,
    schedule: ReturnType<typeof mapRecoverySchedule>
  ) => Promise<void>
) {
  const body = recoveryScheduleCreateSchema.parse(input);
  const id = uuid();
  const nextRunAt = new Date(Date.now() + body.intervalMs);
  const result = await withTransaction(async (client) => {
    await assertBackupTargetUsableForReference(client, body.backupTargetId);
    const result = await client.query(
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
    const schedule = mapRecoverySchedule(result.rows[0]);
    await onCreated?.(client, schedule);
    return schedule;
  });
  return result;
}

export async function deleteRecoverySchedule(
  id: string,
  onDeleted?: (
    client: pg.PoolClient,
    schedule: ReturnType<typeof mapRecoverySchedule>
  ) => Promise<void>
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      "DELETE FROM recovery_schedules WHERE id = $1 RETURNING *",
      [id]
    );
    if (!result.rows[0]) return null;
    const schedule = mapRecoverySchedule(result.rows[0]);
    await onDeleted?.(client, schedule);
    return schedule;
  });
}

export async function runDueRecoverySchedules() {
  const due = await query(
    `SELECT *, xmin::text AS row_version
     FROM recovery_schedules
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
      const sourceDockerScope =
        preparedRecoverySourceDockerScope(prepared);
      const scheduled = await withTransaction(async (client) => {
        const locked = await client.query(
          `SELECT *, xmin::text AS row_version
           FROM recovery_schedules
           WHERE id = $1
           FOR UPDATE`,
          [row.id]
        );
        const current = locked.rows[0];
        if (!current || !current.enabled || new Date(current.next_run_at) > new Date()) return null;
        if (current.row_version !== row.row_version) {
          // The point was prepared from the pre-lock schedule snapshot. A
          // concurrent edit invalidates it; the next pass will prepare from
          // the current configuration.
          return null;
        }
        const nextRunAt = new Date(Date.now() + Number(current.interval_ms));
        await client.query(
          `UPDATE recovery_schedules
           SET last_run_at = now(), next_run_at = $2, updated_at = now()
           WHERE id = $1`,
          [current.id, nextRunAt]
        );
        await lockRecoveryOperationAdmission(client, {
          kind: "capture",
          recoveryPointId: prepared.id,
          sourceScopeKeys: preparedRecoverySourceScopeKeys(prepared),
          sourceDockerScopes: [sourceDockerScope]
        });
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
        await persistRecoveryDockerMutationScopes(client, job.id, {
          source: [sourceDockerScope]
        });
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

export async function createMigrationPlan(
  input: MigrationPlanRequest,
  createdBy?: string | null,
  onCreated?: (
    client: pg.PoolClient,
    run: ReturnType<typeof mapMigrationRun>
  ) => Promise<void>
) {
  // Planning should use current inventories. A failed refresh is represented by
  // the availability checks in the resulting plan instead of hiding the plan.
  await refreshMigrationInventories(input.sourceHostId, input.targetHostId).catch(() => undefined);
  const context = await resolveAppContext(input.sourceHostId, input.sourceAppIdentity);
  const plan = await analyzeMigrationPlan(input, context);
  const id = uuid();
  const insertPlan = async (
    executeQuery: (
      text: string,
      values?: unknown[]
    ) => Promise<{ rows: any[] }>
  ) => {
    const result = await executeQuery(
      `INSERT INTO migration_runs
        (id, source_host_id, target_host_id, source_app_identity, mode, status, plan, created_by, started_at, completed_at)
       VALUES ($1, $2, $3, $4, 'plan', 'completed', $5, $6, now(), now())
       RETURNING *`,
      [id, input.sourceHostId, input.targetHostId, input.sourceAppIdentity, plan, createdBy ?? null]
    );
    return mapMigrationRun(result.rows[0]);
  };
  if (!onCreated) {
    return insertPlan(query);
  }
  return withTransaction(async (client) => {
    const run = await insertPlan(
      (text, values) => client.query(text, values)
    );
    await onCreated(client, run);
    return run;
  });
}

export async function getMigrationRun(id: string) {
  const result = await query("SELECT * FROM migration_runs WHERE id = $1", [id]);
  return result.rows[0] ? mapMigrationRun(result.rows[0]) : null;
}

export async function listMigrationRuns() {
  const result = await query("SELECT * FROM migration_runs ORDER BY created_at DESC");
  return result.rows.map(mapMigrationRun);
}

function conservativeMigrationTargetDockerScope(
  targetHostId: string,
  projectName: string | null,
  projectNameOverride?: string
): DockerMutationScope {
  const targets: DockerMutationScope["targets"] = [
    { hostId: targetHostId, kind: "container", value: "*" },
    { hostId: targetHostId, kind: "network", value: "*" },
    { hostId: targetHostId, kind: "volume", value: "*" },
    { hostId: targetHostId, kind: "host-path", value: "*" }
  ];
  const intendedProject = (
    projectNameOverride
    ?? projectName
    ?? ""
  ).trim().toLowerCase();
  if (intendedProject) {
    targets.push({
      hostId: targetHostId,
      kind: "compose-project",
      value: intendedProject
    });
  }
  return {
    type: "compose.deployPath",
    hostIds: [targetHostId],
    targets
  };
}

export async function startMigrationExecute(
  input: MigrationExecuteRequest,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: {
      run: ReturnType<typeof mapMigrationRun>;
      job: Awaited<ReturnType<typeof enqueueJobInTransaction>>;
    }
  ) => Promise<void>
) {
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
  const executionContext = await resolveAppContext(
    planRun.sourceHostId,
    planRun.sourceAppIdentity
  );
  const operationSourceScopeKeys = buildRecoverySourceOperationScopeKeys(
    planRun.sourceHostId,
    planRun.sourceAppIdentity,
    executionContext
  );
  const sourceDockerScope = buildRecoverySourceDockerMutationScope(
    planRun.sourceHostId,
    planRun.sourceAppIdentity,
    executionContext
  );
  const suppliedRestorePlan = recoveryPointId
    ? await loadRecoveryRestorePlan({
        recoveryPointId,
        targetHostId: planRun.targetHostId,
        options: {
          mode: "clone",
          stopExisting: false,
          projectNameOverride: intent.options.projectNameOverride,
          remapPorts: intent.options.remapPorts,
          networkMode: intent.options.networkMode
        }
      })
    : null;
  const targetDockerScope = suppliedRestorePlan?.dockerMutationScope
    ?? conservativeMigrationTargetDockerScope(
      planRun.targetHostId,
      executionContext.projectName,
      intent.options.projectNameOverride
    );
  const operationTargetScopeKeys =
    buildRecoveryTargetOperationScopeKeys(targetDockerScope);

  const id = uuid();
  const transactionResult = await withTransaction(async (client) => {
    await lockRecoveryOperationAdmission(client, {
      kind: "migration",
      recoveryPointId: recoveryPointId ?? null,
      sourceScopeKeys: operationSourceScopeKeys,
      targetScopeKeys: operationTargetScopeKeys,
      sourceDockerScopes: [sourceDockerScope],
      targetDockerScopes: [targetDockerScope]
    });
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
        metadata: Record<string, unknown>;
      }>(
        `SELECT host_id, app_identity, status, migration_run_id, metadata
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
        || recoveryPointHasDeletionClaim(point.metadata)
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
    const storedPlan = {
      ...currentPlan,
      [MIGRATION_SOURCE_SCOPE_PLAN_KEY]: operationSourceScopeKeys,
      [MIGRATION_TARGET_SCOPE_PLAN_KEY]: operationTargetScopeKeys
    };
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
        storedPlan,
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
    await persistRecoveryDockerMutationScopes(client, job.id, {
      source: [sourceDockerScope],
      target: [targetDockerScope]
    });
    const queued = { run, job };
    await onQueued?.(client, queued);
    return queued;
  });
  await notifyJobQueued(transactionResult.job.id);
  return transactionResult;
}

async function enqueueRecoveryPointOperation(
  recoveryPointId: string,
  action: (row: any) => DockerActionRequest,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: { point: ReturnType<typeof mapRecoveryPoint>; job: Awaited<ReturnType<typeof enqueueJobInTransaction>> }
  ) => Promise<void>
  ,
  operationDockerScopes: {
    source?: readonly DockerMutationScope[];
    target?: readonly DockerMutationScope[];
  } = {}
) {
  const queued = await withTransaction(async (client) => {
    const pointResult = await client.query(
      "SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE",
      [recoveryPointId]
    );
    const row = pointResult.rows[0];
    if (!row) return null;
    if (recoveryPointHasDeletionClaim(row.metadata)) {
      throw Object.assign(
        new Error("A recovery point being deleted cannot accept new operations"),
        { statusCode: 409 }
      );
    }
    const queuedAction = action(row);
    const pointMetadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {};
    const storedSourceScopeKeys = Array.isArray(pointMetadata[RECOVERY_SOURCE_SCOPE_METADATA_KEY])
      ? (pointMetadata[RECOVERY_SOURCE_SCOPE_METADATA_KEY] as unknown[])
        .filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const admissionKind: RecoveryAdmissionOperationKind =
      queuedAction.type === "recovery.create" || queuedAction.type === "recovery.capture"
        ? "capture"
        : queuedAction.type === "recovery.restore"
          ? "restore"
          : "verify";
    const sourceDockerScopes = admissionKind === "capture"
      ? (
          operationDockerScopes.source?.length
            ? [...operationDockerScopes.source]
            : [
                buildRecoverySourceDockerMutationScope(
                  row.host_id,
                  recoveryAppIdentitySchema.parse(row.app_identity),
                  {
                    projectName:
                      typeof pointMetadata.projectName === "string"
                        ? pointMetadata.projectName
                        : null,
                    stackId:
                      typeof pointMetadata.stackId === "string"
                        ? pointMetadata.stackId
                        : null
                  }
                )
              ]
        )
      : [];
    const targetDockerScopes = admissionKind === "restore"
      ? [...(operationDockerScopes.target ?? [])]
      : [];
    await lockRecoveryOperationAdmission(client, {
      kind: admissionKind,
      recoveryPointId,
      sourceScopeKeys: admissionKind === "capture"
        ? (
          storedSourceScopeKeys.length
            ? storedSourceScopeKeys
            : buildRecoverySourceOperationScopeKeys(
              row.host_id,
              recoveryAppIdentitySchema.parse(row.app_identity),
              {
                projectName: typeof pointMetadata.projectName === "string"
                  ? pointMetadata.projectName
                  : null,
                stackId: typeof pointMetadata.stackId === "string"
                  ? pointMetadata.stackId
                  : null
              }
            )
        )
        : [],
      targetScopeKeys: admissionKind === "restore"
        ? targetDockerScopes.flatMap(
            buildRecoveryTargetOperationScopeKeys
          )
        : [],
      sourceDockerScopes,
      targetDockerScopes
    });
    const job = await enqueueJobInTransaction(
      client,
      queuedAction,
      createdBy ?? undefined
    );
    if (sourceDockerScopes.length || targetDockerScopes.length) {
      await persistRecoveryDockerMutationScopes(client, job.id, {
        source: sourceDockerScopes,
        target: targetDockerScopes
      });
    }
    const result = { point: mapRecoveryPoint(row), job };
    await onQueued?.(client, result);
    return result;
  });
  if (!queued) return null;
  await notifyJobQueued(queued.job.id);
  return queued;
}

export async function enqueueRecoveryCreate(recoveryPointId: string, hostId: string, createdBy?: string | null, stopFirst = false) {
  const queued = await enqueueRecoveryPointOperation(
    recoveryPointId,
    (row) => {
      if (row.host_id !== hostId) {
        throw Object.assign(
          new Error("Recovery point host does not match the requested host"),
          { statusCode: 409 }
        );
      }
      return {
        type: "recovery.create",
        hostId: row.host_id,
        payload: { recoveryPointId, stopFirst }
      };
    },
    createdBy
  );
  return queued?.job ?? null;
}

/** @deprecated Use enqueueRecoveryCreate */
export async function enqueueRecoveryCapture(recoveryPointId: string, hostId: string, createdBy?: string | null) {
  return enqueueRecoveryCreate(recoveryPointId, hostId, createdBy);
}

export async function enqueueRecoveryVerify(
  recoveryPointId: string,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: { point: ReturnType<typeof mapRecoveryPoint>; job: Awaited<ReturnType<typeof enqueueJobInTransaction>> }
  ) => Promise<void>
) {
  return enqueueRecoveryPointOperation(
    recoveryPointId,
    (row) => ({
      type: "recovery.verify",
      hostId: row.host_id,
      payload: { recoveryPointId }
    }),
    createdBy,
    onQueued
  );
}

export async function enqueueRecoveryRestore(
  input: RecoveryRestoreRequest,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: {
      point: ReturnType<typeof mapRecoveryPoint>;
      job: Awaited<ReturnType<
        typeof enqueueJobInTransaction
      >>;
    }
  ) => Promise<void>
) {
  const restorePlan = await loadRecoveryRestorePlan(input);
  return enqueueRecoveryPointOperation(
    input.recoveryPointId,
    () => ({
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
    }),
    createdBy,
    onQueued,
    { target: [restorePlan.dockerMutationScope] }
  );
}

export async function enqueueRecoveryDrill(
  recoveryPointId: string,
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    result: {
      point: ReturnType<typeof mapRecoveryPoint>;
      job: Awaited<ReturnType<
        typeof enqueueJobInTransaction
      >>;
    }
  ) => Promise<void>
) {
  const drillPoint = await getRecoveryPoint(recoveryPointId);
  if (!drillPoint) return null;
  const drillInput: RecoveryRestoreRequest = {
    recoveryPointId,
    targetHostId: drillPoint.hostId,
    options: {
      mode: "clone",
      stopExisting: false,
      remapPorts: true,
      networkMode: "clone"
    }
  };
  const restorePlan = await loadRecoveryRestorePlan(drillInput);
  const queued = await withTransaction(async (client) => {
    const pointResult = await client.query(
      "SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE",
      [recoveryPointId]
    );
    const row = pointResult.rows[0];
    if (!row) return null;
    if (recoveryPointHasDeletionClaim(row.metadata)) {
      throw Object.assign(
        new Error("A recovery point being deleted cannot accept new operations"),
        { statusCode: 409 }
      );
    }
    await lockRecoveryOperationAdmission(client, {
      kind: "restore",
      recoveryPointId,
      targetScopeKeys: buildRecoveryTargetOperationScopeKeys(
        restorePlan.dockerMutationScope
      ),
      targetDockerScopes: [restorePlan.dockerMutationScope]
    });
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
    await persistRecoveryDockerMutationScopes(client, job.id, {
      target: [restorePlan.dockerMutationScope]
    });
    const result = {
      point: mapRecoveryPoint(row),
      job
    };
    await onQueued?.(client, result);
    return result;
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
