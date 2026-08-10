import path from "node:path";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import {
  sanitizeUrlDiagnosticText,
  type RecoveryPointDetail,
  type RecoveryProfile
} from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { runDocker } from "./docker.js";
import { getHostForWorker } from "./hosts.js";
import { mapRecoveryArtifact, mapRecoveryPoint } from "./mappers.js";
import { isComposeApp, resolveAppContext } from "./recoveryAppContext.js";
import {
  bindMountArtifactName,
  buildContainerManifest,
  buildNetworkManifest,
  buildRecoveryManifest,
  composeWorkingDirHostFolder,
  containersToRestart,
  isDockerDesktopOperatingSystem,
  isHostPathInside,
  recordRunningStates,
  sanitizeArtifactName,
  wasAnyContainerRunning
} from "./recoveryManifest.js";
import {
  startContainersOneByOne,
  stopContainersWithRestartOnFailure
} from "./recoveryContainerControl.js";
import { buildBindMountCaptureCommand } from "./recoveryRestoreUtils.js";
import { enforceScheduledRecoveryRetention } from "./recoveryRetention.js";
import {
  artifactRelativePath,
  hashFile,
  safeRecoveryPointFile
} from "./recoveryStorage.js";
import {
  resolveRecoveryPointStatus
} from "./recoveryS3.js";
import {
  buildRemoteObjectKey,
  deleteRemoteArtifact,
  downloadRemoteArtifactAtomically,
  headRemoteArtifact,
  uploadRemoteArtifact
} from "./recoveryRemoteStorage.js";
import {
  beginRemoteArtifactWriteIntent,
  clearRemoteArtifactWriteIntent,
  recordRemoteArtifactOrphan,
  releaseRemoteArtifactWriteIntent,
  type RemoteArtifactWriteIntent
} from "./recoveryRemoteOrphans.js";
import {
  readRecoveryArtifact,
  withRecoveryArtifactLocalPath,
  withRecoveryArtifactRemotePath
} from "./recoveryArtifactStore.js";
import {
  createRecoveryTemporaryDirectory,
  preserveTrackedRecoveryTemporaryDirectory,
  removeTrackedRecoveryTemporaryDirectory
} from "./recoveryTemporaryStorage.js";
import { getRecoveryProfile } from "./recoveryProfiles.js";
import { runSshCommand, streamSshCommandToFile } from "./ssh.js";
import type { JobExecutionFence } from "./jobs.js";

type InspectRow = { id: string; inspect: Record<string, unknown> };
type RecoveryCaptureError = Error & {
  restartFailedIds?: string[];
  sourceStoppedIds?: string[];
};

type RecoveryCaptureAttempt = {
  token: string;
  directory: string;
};

function safeRecoveryDiagnosticMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return String(sanitizeUrlDiagnosticText(raw));
}

function remoteArtifactUploadFailure(error: unknown) {
  if (
    !(error instanceof Error)
    || (error as { code?: unknown }).code !== "REMOTE_ARTIFACT_UPLOAD_FAILED"
  ) {
    return null;
  }
  return error as Error & {
    uploadError: string;
    expectedRemoteObject: {
      key: string;
      backend: "s3" | "rclone";
    };
    remoteObjectDeletedAfterAmbiguousUpload: boolean;
    orphanRemoteObject: {
      key: string;
      backend: "s3" | "rclone";
      cleanupError: string;
    } | null;
  };
}

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

async function executionQuery(fence: JobExecutionFence | undefined, text: string, values: unknown[]) {
  if (!fence) return query(text, values);
  return fence.withActiveLease((client) => client.query(text, values));
}

function assertRecoveryCaptureAttemptUpdated(
  result: { rowCount?: number | null },
  recoveryPointId: string
) {
  if (result.rowCount === 0) {
    throw Object.assign(
      new Error(`Recovery capture attempt no longer owns recovery point ${recoveryPointId}`),
      { code: "RECOVERY_CAPTURE_ATTEMPT_LOST" }
    );
  }
}

function recoveryCaptureAttemptArtifactPath(
  recoveryPointId: string,
  attempt: RecoveryCaptureAttempt,
  storageKey: string
) {
  const canonicalPath = safeRecoveryPointFile(recoveryPointId, storageKey);
  const pointRoot = safeRecoveryPointFile(recoveryPointId, ".");
  const relative = path.relative(pointRoot, canonicalPath);
  const candidate = path.resolve(attempt.directory, relative);
  const attemptRoot = path.resolve(attempt.directory);
  if (candidate === attemptRoot || !candidate.startsWith(`${attemptRoot}${path.sep}`)) {
    throw new Error("Recovery capture attempt path escapes its private directory");
  }
  return candidate;
}

async function writeRecoveryCaptureAttemptFile(
  recoveryPointId: string,
  attempt: RecoveryCaptureAttempt,
  storageKey: string,
  content: Buffer | string
) {
  const targetPath = recoveryCaptureAttemptArtifactPath(recoveryPointId, attempt, storageKey);
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await writeFile(targetPath, content, { mode: 0o600 });
  const fileStat = await stat(targetPath);
  const checksum = await hashFile(targetPath);
  return { path: targetPath, sizeBytes: fileStat.size, checksum };
}

async function withRecoveryCaptureAttemptLock<T>(
  recoveryPointId: string,
  captureAttemptToken: string,
  executionFence: JobExecutionFence | undefined,
  callback: (client: PoolClient) => Promise<T>
) {
  const locked = async (client: PoolClient) => {
    const selected = await client.query<{
      metadata: Record<string, unknown>;
    }>(
      "SELECT metadata FROM recovery_points WHERE id = $1 FOR UPDATE",
      [recoveryPointId]
    );
    const point = selected.rows[0];
    if (
      !point
      || point.metadata?.captureAttemptToken !== captureAttemptToken
      || point.metadata?.deletionClaimToken
    ) {
      throw Object.assign(
        new Error(`Recovery capture attempt no longer owns recovery point ${recoveryPointId}`),
        { code: "RECOVERY_CAPTURE_ATTEMPT_LOST" }
      );
    }
    return callback(client);
  };
  return executionFence
    ? executionFence.withActiveLease(locked)
    : withTransaction(locked);
}

async function publishRecoveryCaptureArtifact(input: {
  recoveryPointId: string;
  artifactId: string;
  storageKey: string;
  attempt: RecoveryCaptureAttempt;
  sizeBytes: number;
  checksum: string;
  executionFence?: JobExecutionFence;
}) {
  const attemptPath = recoveryCaptureAttemptArtifactPath(
    input.recoveryPointId,
    input.attempt,
    input.storageKey
  );
  const publishPath = `${attemptPath}.publish`;
  await copyFile(attemptPath, publishPath);
  try {
    try {
      await withRecoveryCaptureAttemptLock(
        input.recoveryPointId,
        input.attempt.token,
        input.executionFence,
        async (client) => {
        const canonicalPath = safeRecoveryPointFile(input.recoveryPointId, input.storageKey);
        await mkdir(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
        await rename(publishPath, canonicalPath);
        const updated = await client.query(
          `UPDATE recovery_artifacts
           SET status = 'completed',
               size_bytes = $2,
               checksum = $3,
               error = NULL,
               metadata = metadata || $5::jsonb,
               completed_at = now()
           WHERE id = $1
             AND EXISTS (
               SELECT 1
               FROM recovery_points point
               WHERE point.id = recovery_artifacts.recovery_point_id
                 AND point.metadata->>'captureAttemptToken' = $4
                 AND point.metadata->>'deletionClaimToken' IS NULL
             )
           RETURNING id`,
          [
            input.artifactId,
            input.sizeBytes,
            input.checksum,
            input.attempt.token,
            JSON.stringify({
              localCaptureAttemptToken: input.attempt.token,
              localCaptureCompletedAt: new Date().toISOString()
            })
          ]
        );
        assertRecoveryCaptureAttemptUpdated(updated, input.recoveryPointId);
        }
      );
    } catch (commitError) {
      let current;
      try {
        const result = await query<{
          size_bytes: string | number | null;
          checksum: string | null;
          metadata: Record<string, unknown>;
        }>(
          `SELECT size_bytes, checksum, metadata
           FROM recovery_artifacts
           WHERE id = $1`,
          [input.artifactId]
        );
        current = result.rows[0] ?? null;
      } catch (readError) {
        let preservationError: unknown = null;
        try {
          await preserveTrackedRecoveryTemporaryDirectory(
            input.attempt.directory,
            {
              recoveryPointId: input.recoveryPointId,
              artifactId: input.artifactId,
              attemptToken: input.attempt.token,
              storageKey: input.storageKey,
              sizeBytes: input.sizeBytes,
              checksum: input.checksum
            }
          );
        } catch (error) {
          preservationError = error;
        }
        throw Object.assign(
          new AggregateError(
            [
              commitError,
              readError,
              ...(preservationError ? [preservationError] : [])
            ],
            "Recovery artifact publication outcome is unknown; attempt-owned files were preserved for reconciliation"
          ),
          { code: "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED" as const }
        );
      }
      if (
        current?.metadata?.localCaptureAttemptToken === input.attempt.token
        && Number(current.size_bytes) === input.sizeBytes
        && current.checksum === input.checksum
      ) {
        return;
      }
      throw commitError;
    }
  } finally {
    await rm(publishPath, { force: true }).catch(() => undefined);
  }
}

export async function resolveRecoverySourceRestartObligation(
  recoveryPointId: string,
  input: {
    sourceLeftStopped: boolean;
    containerIds: string[];
    resolution: "restarted" | "intentionally_left_stopped" | "stop_not_applied";
  },
  executionFence?: JobExecutionFence,
  durableAfterLeaseLoss = false,
  captureAttemptToken?: string
) {
  const containerIds = [...new Set(input.containerIds.filter(Boolean))];
  const sql = `UPDATE recovery_points
    SET metadata = (
      metadata
      - 'sourceRestartReconciliationToken'
      - 'sourceRestartReconciliationStartedAt'
      - 'sourceRestartReconciliationError'
    ) || $2::jsonb
    WHERE id = $1
    ${captureAttemptToken ? "AND metadata->>'captureAttemptToken' = $3" : ""}
    RETURNING id`;
  const values = [
    recoveryPointId,
    JSON.stringify({
      sourceRestartPending: false,
      sourceRestartContainerIds: [],
      sourceLeftStopped: input.sourceLeftStopped,
      sourceStoppedIds: input.sourceLeftStopped ? containerIds : [],
      stoppedContainerIds: input.sourceLeftStopped ? containerIds : [],
      restartFailedIds: [],
      sourceRestartResolvedAt: new Date().toISOString(),
      sourceRestartResolution: input.resolution,
      sourceRestartReconciliationState: "completed"
    }),
    ...(captureAttemptToken ? [captureAttemptToken] : [])
  ];
  try {
    const result = await executionQuery(executionFence, sql, values);
    assertRecoveryCaptureAttemptUpdated(result, recoveryPointId);
  } catch (fencedError) {
    if (!durableAfterLeaseLoss || !captureAttemptToken) throw fencedError;
    try {
      // This fallback records only the restart outcome of the attempt that
      // created the obligation. If a newer capture replaced the token, the
      // conditional update is a no-op and its state remains authoritative.
      await query(sql, values);
    } catch (durabilityError) {
      throw new AggregateError(
        [fencedError, durabilityError],
        "Recovery source restart completed but its durable obligation could not be resolved"
      );
    }
    throw fencedError;
  }
}

async function findResource(hostId: string, kind: string, externalId: string) {
  const result = await query<any>(
    `SELECT data FROM resource_snapshots WHERE host_id = $1 AND kind = $2 AND external_id = $3`,
    [hostId, kind, externalId]
  );
  return result.rows[0] ?? null;
}

async function inspectContainer(hostId: string, containerId: string): Promise<Record<string, unknown>> {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const row = await findResource(hostId, "container", containerId);
    if (!row) throw new Error(`Demo container not found: ${containerId}`);
    const data = row.data ?? {};
    return {
      Id: containerId,
      Name: String(data.Names ?? containerId),
      State: { Running: String(data.State ?? "").toLowerCase().includes("running"), Status: String(data.State ?? "running") },
      Config: { Image: String(data.Image ?? "demo:latest"), Env: [], Labels: data.Labels ?? {} },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: {} },
      NetworkSettings: { Ports: data.Ports ? { "80/tcp": [{ HostPort: "8080" }] } : {}, Networks: { bridge: {} } },
      Mounts: data.Mounts ?? []
    };
  }
  const result = await runDocker(hostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  const [inspect] = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  if (!inspect) throw new Error(`Container not found: ${containerId}`);
  return inspect;
}

async function getDockerVersions(hostId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return { serverVersion: host.public.dockerVersion, composeVersion: host.public.composeVersion };
  }
  try {
    const version = await runDocker(hostId, "docker version --format '{{.Server.Version}}'", 30_000);
    const compose = await runDocker(hostId, "docker compose version --short", 30_000);
    return { serverVersion: version.stdout.trim(), composeVersion: compose.stdout.trim() };
  } catch {
    return { serverVersion: host.public.dockerVersion, composeVersion: host.public.composeVersion };
  }
}

async function dockerDesktopBindAliasesAvailable(hostId: string) {
  try {
    const result = await runDocker(hostId, "docker info --format '{{.OperatingSystem}}'", 30_000);
    return isDockerDesktopOperatingSystem(result.stdout);
  } catch {
    return false;
  }
}

async function updateArtifactStatus(
  artifactId: string,
  status: string,
  fields: { sizeBytes?: number | null; checksum?: string | null; error?: string | null } = {},
  executionFence?: JobExecutionFence,
  captureAttemptToken?: string
) {
  if (!captureAttemptToken) {
    throw new Error("Recovery artifact status updates require a capture attempt token");
  }
  const updated = await executionQuery(
    executionFence,
    `UPDATE recovery_artifacts
     SET status = $2,
         size_bytes = COALESCE($3, size_bytes),
         checksum = COALESCE($4, checksum),
         error = $5,
         completed_at = CASE WHEN $2 IN ('completed', 'partial', 'failed') THEN now() ELSE completed_at END
     WHERE id = $1
       AND EXISTS (
         SELECT 1
         FROM recovery_points point
         WHERE point.id = recovery_artifacts.recovery_point_id
           AND point.metadata->>'captureAttemptToken' = $6
           AND point.metadata->>'deletionClaimToken' IS NULL
       )
     RETURNING id`,
    [
      artifactId,
      status,
      fields.sizeBytes ?? null,
      fields.checksum ?? null,
      fields.error ?? null,
      captureAttemptToken
    ]
  );
  assertRecoveryCaptureAttemptUpdated(updated, artifactId);
}

async function insertArtifact(
  recoveryPointId: string,
  kind: string,
  storageKey: string,
  metadata: Record<string, unknown>,
  executionFence: JobExecutionFence | undefined,
  captureAttemptToken: string
) {
  const id = uuid();
  const insert = async (client: { query: typeof query }) => {
    const owner = await client.query(
      `SELECT id
       FROM recovery_points
       WHERE id = $1
         AND metadata->>'captureAttemptToken' = $2
         AND metadata->>'deletionClaimToken' IS NULL
       FOR UPDATE`,
      [recoveryPointId, captureAttemptToken]
    );
    assertRecoveryCaptureAttemptUpdated(owner, recoveryPointId);
    await client.query(
      `INSERT INTO recovery_artifacts
        (id, recovery_point_id, kind, backup_target_id, storage_key, status, metadata)
       VALUES ($1, $2, $3, NULL, $4, 'queued', $5)`,
      [id, recoveryPointId, kind, storageKey, metadata]
    );
    await client.query(
      `UPDATE recovery_points
       SET artifact_count = artifact_count + 1
       WHERE id = $1
         AND metadata->>'captureAttemptToken' = $2`,
      [recoveryPointId, captureAttemptToken]
    );
  };
  if (executionFence) await executionFence.withActiveLease(insert);
  else await withTransaction(insert);
  return id;
}

async function loadRecoveryPoint(recoveryPointId: string): Promise<RecoveryPointDetail | null> {
  const result = await query("SELECT * FROM recovery_points WHERE id = $1", [recoveryPointId]);
  if (!result.rows[0]) return null;
  const artifacts = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [recoveryPointId]
  );
  return {
    ...mapRecoveryPoint(result.rows[0]),
    artifacts: artifacts.rows.map(mapRecoveryArtifact)
  };
}

async function finalizeRecoveryPoint(
  recoveryPointId: string,
  captureAttemptToken: string,
  remoteUploadFailures = 0,
  executionFence?: JobExecutionFence
) {
  await executionFence?.assertActive();
  const artifacts = await query<any>(
    "SELECT status FROM recovery_artifacts WHERE recovery_point_id = $1",
    [recoveryPointId]
  );
  const statuses = artifacts.rows.map((row: any) => row.status);
  const localCompleted = statuses.filter((status: string) => status === "completed").length;
  const localFailed = statuses.filter((status: string) => status === "failed").length;
  const totalBytes = await query<any>(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM recovery_artifacts WHERE recovery_point_id = $1",
    [recoveryPointId]
  );

  const resolved = resolveRecoveryPointStatus({ localCompleted, localFailed, remoteUploadFailures });

  const finalized = await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET status = $2,
         completed_artifact_count = $3,
         total_bytes = $4,
         error = $5,
         completed_at = now()
     WHERE id = $1
       AND metadata->>'captureAttemptToken' = $6
     RETURNING id`,
    [
      recoveryPointId,
      resolved.status,
      localCompleted,
      Number(totalBytes.rows[0]?.total ?? 0),
      resolved.error,
      captureAttemptToken
    ]
  );
  assertRecoveryCaptureAttemptUpdated(finalized, recoveryPointId);
}

export async function uploadRecoveryArtifactsToRemote(
  recoveryPointId: string,
  backupTargetId: string,
  attempt: RecoveryCaptureAttempt,
  executionFence?: JobExecutionFence
) {
  const target = await loadWorkerBackupTarget(backupTargetId);
  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point) throw new Error("Recovery point not found during remote upload");
  if (!target.enabled) throw new Error(`Backup target ${target.name} is disabled`);
  if (target.kind === "local") {
    const updated = await executionQuery(
      executionFence,
      `UPDATE recovery_points
       SET metadata = metadata || $2::jsonb
       WHERE id = $1
         AND metadata->>'captureAttemptToken' = $3
       RETURNING id`,
      [recoveryPointId, JSON.stringify({
        remoteUploadAttempted: false,
        remoteUploadNotApplicable: true,
        backupTargetKind: "local"
      }), attempt.token]
    );
    assertRecoveryCaptureAttemptUpdated(updated, recoveryPointId);
    return 0;
  }
  if (
    (target.kind === "s3" && !target.s3)
    || (target.kind === "rclone" && !target.rclone)
    || (target.kind !== "s3" && target.kind !== "rclone")
  ) {
    throw new Error(`Backup target ${target.name} does not support remote recovery artifacts`);
  }
  let failures = 0;
  let attempted = 0;
  let uploadedCount = 0;
  const verifiedObjectKeys: string[] = [];

  for (const artifact of point.artifacts) {
    if (artifact.status !== "completed") continue;
    attempted += 1;
    const localPath = recoveryCaptureAttemptArtifactPath(
      recoveryPointId,
      attempt,
      artifact.storageKey
    );
    const remoteStorageKey = path.posix.join(
      "attempts",
      attempt.token,
      artifact.storageKey
    );
    const expectedRemoteObjectKey = buildRemoteObjectKey(
      target,
      recoveryPointId,
      remoteStorageKey
    );
    let uploaded: Awaited<ReturnType<typeof uploadRemoteArtifact>> = null;
    let writeIntent: RemoteArtifactWriteIntent | null = null;
    try {
      await executionFence?.assertActive();
      const localStat = await stat(localPath);
      writeIntent = await beginRemoteArtifactWriteIntent({
        ownerKind: "recovery_artifact",
        ownerId: artifact.id,
        backupTargetId,
        objectKey: expectedRemoteObjectKey,
        backend: target.kind,
        attemptToken: attempt.token,
        target
      });
      await executionFence?.assertActive();
      uploaded = await uploadRemoteArtifact({
        target,
        namespaceId: recoveryPointId,
        storageKey: remoteStorageKey,
        localPath,
        checksum: artifact.checksum
      });
      if (!uploaded) {
        throw new Error(`Backup target ${target.name} did not store recovery artifact ${artifact.storageKey}`);
      }
      if (
        uploaded.remoteObjectKey !== expectedRemoteObjectKey
        || uploaded.remoteBackend !== target.kind
      ) {
        throw new Error(
          `Backup target ${target.name} returned an unexpected remote artifact locator`
        );
      }
      const verifiedUpload = uploaded;
      const remoteHead = await headRemoteArtifact(target, verifiedUpload.remoteObjectKey);
      if (remoteHead.sizeBytes == null || remoteHead.sizeBytes !== localStat.size) {
        throw new Error(
          `Remote artifact ${artifact.storageKey} size verification failed: expected ${localStat.size}, got ${String(remoteHead.sizeBytes)}`
        );
      }
      const expectedChecksum = artifact.checksum ?? await hashFile(localPath);
      const verificationDirectory = await createRecoveryTemporaryDirectory(
        recoveryPointId,
        ".remote-verification",
        artifact.id
      );
      const verificationPath = path.join(
        verificationDirectory,
        path.basename(artifact.storageKey)
      );
      let verifiedSizeBytes: number;
      let verifiedChecksum: string;
      try {
        await downloadRemoteArtifactAtomically(target, verifiedUpload.remoteObjectKey, verificationPath);
        const verifiedStat = await stat(verificationPath);
        verifiedSizeBytes = verifiedStat.size;
        if (verifiedSizeBytes !== localStat.size) {
          throw new Error(
            `Downloaded remote artifact ${artifact.storageKey} size verification failed: expected ${localStat.size}, got ${verifiedSizeBytes}`
          );
        }
        verifiedChecksum = await hashFile(verificationPath);
        if (verifiedChecksum !== expectedChecksum) {
          throw new Error(`Downloaded remote artifact ${artifact.storageKey} checksum verification failed`);
        }
      } finally {
        await removeTrackedRecoveryTemporaryDirectory(verificationDirectory);
      }
      try {
        await withRecoveryCaptureAttemptLock(
          recoveryPointId,
          attempt.token,
          executionFence,
          async (client) => {
            const locatorCommitted = await client.query(
              `UPDATE recovery_artifacts
               SET backup_target_id = $2,
                   error = NULL,
                   metadata = metadata || $3::jsonb
               WHERE id = $1
                 AND EXISTS (
                   SELECT 1
                   FROM recovery_points point
                   WHERE point.id = recovery_artifacts.recovery_point_id
                     AND point.metadata->>'captureAttemptToken' = $4
                     AND point.metadata->>'deletionClaimToken' IS NULL
                 )
               RETURNING id`,
              [
                artifact.id,
                backupTargetId,
                JSON.stringify({
                  remoteObjectKey: verifiedUpload.remoteObjectKey,
                  remoteBackend: verifiedUpload.remoteBackend,
                  remoteSizeBytes: verifiedUpload.remoteSizeBytes,
                  remoteEtag: verifiedUpload.remoteEtag,
                  remoteVerified: true,
                  remoteVerifiedAt: new Date().toISOString(),
                  remoteVerifiedSizeBytes: verifiedSizeBytes,
                  remoteVerifiedChecksum: verifiedChecksum,
                  remoteChecksumVerified: true,
                  remoteCaptureAttemptToken: attempt.token,
                  localCachePolicy: target.localCachePolicy,
                  localCacheCleanupAttempted: false,
                  ...(target.localCachePolicy === "keep" ? { localCacheRemoved: false } : {})
                }),
                attempt.token
              ]
            );
            assertRecoveryCaptureAttemptUpdated(locatorCommitted, recoveryPointId);
            if (
              !writeIntent
              || !await clearRemoteArtifactWriteIntent(writeIntent, client)
            ) {
              throw new Error(
                "Recovery remote locator could not atomically clear its write intent"
              );
            }
          }
        );
        writeIntent = null;
      } catch (commitError) {
        let current;
        try {
          const result = await query<{
            backup_target_id: string | null;
            metadata: Record<string, unknown>;
          }>(
            `SELECT backup_target_id, metadata
             FROM recovery_artifacts
             WHERE id = $1`,
            [artifact.id]
          );
          current = result.rows[0] ?? null;
        } catch (readError) {
          let preservationError: unknown = null;
          try {
            await preserveTrackedRecoveryTemporaryDirectory(
              attempt.directory,
              {
                recoveryPointId,
                artifactId: artifact.id,
                attemptToken: attempt.token,
                storageKey: artifact.storageKey,
                remoteObjectKey: uploaded.remoteObjectKey,
                remoteBackend: uploaded.remoteBackend,
                backupTargetId
              }
            );
          } catch (error) {
            preservationError = error;
          }
          throw Object.assign(
            new AggregateError(
              [
                commitError,
                readError,
                ...(preservationError ? [preservationError] : [])
              ],
              "Recovery remote locator commit outcome is unknown; the attempt-owned object was preserved for reconciliation"
            ),
            { code: "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED" as const }
          );
        }
        if (
          current?.backup_target_id !== backupTargetId
          || current.metadata?.remoteObjectKey !== uploaded.remoteObjectKey
          || current.metadata?.remoteCaptureAttemptToken !== attempt.token
          || current.metadata?.remoteVerified !== true
        ) {
          throw commitError;
        }
        // The authoritative locator and intent deletion share one transaction.
        // A read that proves the locator committed also proves the intent cannot
        // still authorize deletion of this object.
        writeIntent = null;
      }
      uploadedCount += 1;
      verifiedObjectKeys.push(uploaded.remoteObjectKey);
      if (target.localCachePolicy === "remote_only") {
        let localCacheRemoved = false;
        let localCacheCleanupError: string | null = null;
        try {
          await withRecoveryCaptureAttemptLock(
            recoveryPointId,
            attempt.token,
            executionFence,
            async (client) => {
              const canonicalPath = safeRecoveryPointFile(
                recoveryPointId,
                artifact.storageKey
              );
              try {
                await rm(canonicalPath, { force: true });
                localCacheRemoved = true;
              } catch (error) {
                localCacheCleanupError = error instanceof Error
                  ? error.message
                  : String(error);
              }
              await client.query(
                `UPDATE recovery_artifacts
                 SET metadata = metadata || $2::jsonb
                 WHERE id = $1
                   AND EXISTS (
                     SELECT 1
                     FROM recovery_points point
                     WHERE point.id = recovery_artifacts.recovery_point_id
                       AND point.metadata->>'captureAttemptToken' = $3
                   )`,
                [
                  artifact.id,
                  JSON.stringify({
                    localCacheCleanupAttempted: true,
                    localCacheRemoved,
                    ...(localCacheRemoved ? {
                      localCacheRemovedAt: new Date().toISOString(),
                      localCacheCleanupError: null
                    } : {
                      localCacheCleanupError
                    })
                  }),
                  attempt.token
                ]
              );
            }
          );
        } catch {
          // The verified remote locator is already durable. Cache cleanup
          // bookkeeping is best-effort and must not turn a successful upload
          // into a remote-artifact failure.
        }
      }
    } catch (error) {
      failures += 1;
      const message = safeRecoveryDiagnosticMessage(error);
      const reconciliationRequired = (
        error instanceof Error
        && (error as { code?: unknown }).code === "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED"
      );
      if (reconciliationRequired) {
        await query(
          `UPDATE recovery_artifacts
           SET metadata = metadata || $3::jsonb
           WHERE id = $1
             AND EXISTS (
               SELECT 1
               FROM recovery_points point
               WHERE point.id = recovery_artifacts.recovery_point_id
                 AND point.metadata->>'captureAttemptToken' = $2
             )`,
          [
            artifact.id,
            attempt.token,
            JSON.stringify({
              remoteCommitReconciliationRequired: true,
              remoteCommitReconciliationError: message,
              pendingAttemptRemoteObjectKey: uploaded?.remoteObjectKey ?? null
            })
          ]
        ).catch(() => undefined);
        throw error;
      }
      const ambiguousUpload = remoteArtifactUploadFailure(error);
      let orphanCleanupError: string | null = null;
      let failedObjectKey: string | null = uploaded?.remoteObjectKey
        ?? ambiguousUpload?.expectedRemoteObject.key
        ?? writeIntent?.objectKey
        ?? null;
      let failedBackend: "s3" | "rclone" | null = uploaded?.remoteBackend
        ?? ambiguousUpload?.expectedRemoteObject.backend
        ?? writeIntent?.backend
        ?? null;
      if (uploaded) {
        try {
          await deleteRemoteArtifact(target, uploaded.remoteObjectKey);
          if (
            writeIntent
            && uploaded.remoteObjectKey === writeIntent.objectKey
          ) {
            await clearRemoteArtifactWriteIntent(writeIntent);
            writeIntent = null;
          }
        } catch (cleanupError) {
          orphanCleanupError = safeRecoveryDiagnosticMessage(cleanupError);
        }
      } else if (ambiguousUpload?.orphanRemoteObject) {
        orphanCleanupError = safeRecoveryDiagnosticMessage(
          ambiguousUpload.orphanRemoteObject.cleanupError
        );
        failedObjectKey = ambiguousUpload.orphanRemoteObject.key;
        failedBackend = ambiguousUpload.orphanRemoteObject.backend;
      } else if (
        ambiguousUpload?.remoteObjectDeletedAfterAmbiguousUpload
        && writeIntent
      ) {
        try {
          await clearRemoteArtifactWriteIntent(writeIntent);
          writeIntent = null;
        } catch (cleanupError) {
          orphanCleanupError = safeRecoveryDiagnosticMessage(cleanupError);
        }
      }
      if (failedObjectKey && failedBackend && orphanCleanupError) {
        await recordRemoteArtifactOrphan({
          ownerKind: "recovery_artifact",
          ownerId: artifact.id,
          backupTargetId,
          objectKey: failedObjectKey,
          backend: failedBackend,
          attemptToken: attempt.token,
          target,
          cleanupError: orphanCleanupError
        });
        if (
          writeIntent
          && failedObjectKey === writeIntent.objectKey
          && failedBackend === writeIntent.backend
        ) {
          writeIntent = null;
        }
      }
      if (writeIntent) {
        await releaseRemoteArtifactWriteIntent(
          writeIntent,
          error
        ).catch(() => undefined);
        writeIntent = null;
      }
      const failureSql = `UPDATE recovery_artifacts
        SET backup_target_id = COALESCE($2, backup_target_id),
            error = $3,
            metadata = metadata || $4::jsonb
        WHERE id = $1
          AND EXISTS (
            SELECT 1
            FROM recovery_points point
            WHERE point.id = recovery_artifacts.recovery_point_id
              AND point.metadata->>'captureAttemptToken' = $5
          )
        RETURNING id`;
      const failureValues = [
        artifact.id,
        failedObjectKey && orphanCleanupError ? backupTargetId : null,
        message,
        JSON.stringify({
          ...(failedObjectKey ? {
            ...(ambiguousUpload
              ? {
                remoteUploadError: safeRecoveryDiagnosticMessage(
                  ambiguousUpload.uploadError
                ),
                remoteObjectDeletedAfterAmbiguousUpload:
                  ambiguousUpload.remoteObjectDeletedAfterAmbiguousUpload
              }
              : {
                remoteVerificationError: message,
                remoteObjectDeletedAfterFailedVerification: orphanCleanupError === null
              }),
            ...(orphanCleanupError ? {
              orphanRemoteObjectKey: failedObjectKey,
              orphanRemoteBackend: failedBackend,
              ...(uploaded ? {
                orphanRemoteSizeBytes: uploaded.remoteSizeBytes,
                orphanRemoteEtag: uploaded.remoteEtag
              } : {}),
              orphanCleanupError
            } : {})
          } : {
            remoteUploadError: message
          }),
          remoteVerified: false,
          localCachePolicy: target.localCachePolicy,
          localCacheCleanupAttempted: false,
          localCacheRemoved: false
        }),
        attempt.token
      ];
      try {
        const failed = await executionQuery(executionFence, failureSql, failureValues);
        assertRecoveryCaptureAttemptUpdated(failed, recoveryPointId);
      } catch (failurePersistenceError) {
        if (failedObjectKey && orphanCleanupError) {
          // Cleanup is durable in remote_artifact_orphans independently of the
          // point row. This token-conditioned write is evidence-only and may
          // become a no-op after a successor or deletion wins.
          await query(failureSql, failureValues).catch(() => undefined);
        }
        throw failurePersistenceError;
      }
    }
  }

  const summary = await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET metadata = metadata || $2::jsonb
     WHERE id = $1
       AND metadata->>'captureAttemptToken' = $3
     RETURNING id`,
    [recoveryPointId, JSON.stringify({
      remoteUploadAttempted: true,
      remoteUploadBackend: target.kind,
      remoteUploadArtifactCount: attempted,
      remoteUploadedArtifactCount: uploadedCount,
      remoteVerifiedArtifactCount: uploadedCount,
      remoteUploadFailureCount: failures,
      remoteUploadComplete: attempted > 0 && failures === 0 && uploadedCount === attempted,
      remoteObjectKeys: verifiedObjectKeys
    }), attempt.token]
  );
  assertRecoveryCaptureAttemptUpdated(summary, recoveryPointId);

  return failures;
}

async function captureNamedVolume(
  hostId: string,
  recoveryPointId: string,
  artifactId: string,
  storageKey: string,
  volumeName: string,
  attempt: RecoveryCaptureAttempt,
  executionFence?: JobExecutionFence
) {
  await executionFence?.assertActive();
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const written = await writeRecoveryCaptureAttemptFile(
      recoveryPointId,
      attempt,
      storageKey,
      `ComposeBastion demo recovery volume for ${volumeName}\n`
    );
    await publishRecoveryCaptureArtifact({
      recoveryPointId,
      artifactId,
      storageKey,
      attempt,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      executionFence
    });
    return written;
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery volume capture requires SSH host mode.");
  }
  const targetPath = recoveryCaptureAttemptArtifactPath(
    recoveryPointId,
    attempt,
    storageKey
  );
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const command = withDockerEnv(
    `docker run --rm -v ${shQuote(`${volumeName}:/volume:ro`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar czf - .")}`,
    host.public.dockerSocketPath
  );
  const result = await streamSshCommandToFile(host.ssh, command, targetPath);
  const checksum = await hashFile(targetPath);
  await publishRecoveryCaptureArtifact({
    recoveryPointId,
    artifactId,
    storageKey,
    attempt,
    sizeBytes: result.sizeBytes,
    checksum,
    executionFence
  });
  return { sizeBytes: result.sizeBytes, checksum };
}

async function captureBindMount(
  hostId: string,
  recoveryPointId: string,
  artifactId: string,
  storageKey: string,
  sourcePath: string,
  attempt: RecoveryCaptureAttempt,
  excludePatterns: string[] = [],
  executionFence?: JobExecutionFence
) {
  await executionFence?.assertActive();
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const written = await writeRecoveryCaptureAttemptFile(
      recoveryPointId,
      attempt,
      storageKey,
      `ComposeBastion demo bind mount backup for ${sourcePath}\n`
    );
    await publishRecoveryCaptureArtifact({
      recoveryPointId,
      artifactId,
      storageKey,
      attempt,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      executionFence
    });
    return written;
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery bind mount capture requires SSH host mode.");
  }
  const normalized = path.posix.normalize(sourcePath);
  const targetPath = recoveryCaptureAttemptArtifactPath(
    recoveryPointId,
    attempt,
    storageKey
  );
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const command = buildBindMountCaptureCommand(normalized, excludePatterns);
  const result = await streamSshCommandToFile(host.ssh, command, targetPath);
  const checksum = await hashFile(targetPath);
  await publishRecoveryCaptureArtifact({
    recoveryPointId,
    artifactId,
    storageKey,
    attempt,
    sizeBytes: result.sizeBytes,
    checksum,
    executionFence
  });
  return { sizeBytes: result.sizeBytes, checksum };
}

async function ensurePlannedArtifacts(
  point: RecoveryPointDetail,
  inspects: InspectRow[],
  context: Awaited<ReturnType<typeof resolveAppContext>>,
  profile: RecoveryProfile | null,
  options: { dockerDesktopAliases?: boolean },
  executionFence: JobExecutionFence | undefined,
  captureAttemptToken: string
) {
  const existingVolumes = new Set(
    point.artifacts.filter((artifact) => artifact.kind === "volume").map((artifact) => String(artifact.metadata.volumeName ?? ""))
  );
  const existingBinds = new Set(
    point.artifacts.filter((artifact) => artifact.kind === "host_folder").map((artifact) => String(artifact.metadata.sourcePath ?? ""))
  );
  const composeFolder = composeWorkingDirHostFolder(context.workingDir);
  const excludePatterns = profile?.excludePatterns ?? [];

  if (composeFolder && !existingBinds.has(composeFolder.source)) {
    const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(composeFolder.source));
    await insertArtifact(point.id, "host_folder", storageKey, {
      sourcePath: composeFolder.source,
      destination: composeFolder.destination,
      readOnly: composeFolder.readOnly,
      role: composeFolder.role,
      restorePath: composeFolder.restorePath,
      excludePatterns
    }, executionFence, captureAttemptToken);
    existingBinds.add(composeFolder.source);
  }

  for (const { inspect } of inspects) {
    const manifest = buildContainerManifest(inspect);
    for (const volume of manifest.volumes) {
      if (existingVolumes.has(volume.name)) continue;
      const storageKey = artifactRelativePath("volume", sanitizeArtifactName(volume.name));
      await insertArtifact(
        point.id,
        "volume",
        storageKey,
        { volumeName: volume.name, destination: volume.destination },
        executionFence,
        captureAttemptToken
      );
      existingVolumes.add(volume.name);
    }
    for (const bind of manifest.bindMounts) {
      if (composeFolder && isHostPathInside(
        composeFolder.source,
        bind.source,
        { dockerDesktopAliases: options.dockerDesktopAliases }
      )) continue;
      if (existingBinds.has(bind.source)) continue;
      const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(bind.source));
      await insertArtifact(point.id, "host_folder", storageKey, {
        sourcePath: bind.source,
        destination: bind.destination,
        readOnly: bind.readOnly,
        excludePatterns
      }, executionFence, captureAttemptToken);
      existingBinds.add(bind.source);
    }
  }

  const extraIncludePaths = Array.isArray(point.metadata.extraIncludePaths)
    ? point.metadata.extraIncludePaths.map(String)
    : [];
  for (const includePath of Array.from(new Set([...(profile?.includePaths ?? []), ...extraIncludePaths]))) {
    if (existingBinds.has(includePath)) continue;
    const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(includePath));
    await insertArtifact(point.id, "host_folder", storageKey, {
      sourcePath: includePath,
      destination: "",
      readOnly: false,
      role: "manual_include",
      restorePath: profile?.restorePaths[includePath] ?? null,
      excludePatterns
    }, executionFence, captureAttemptToken);
    existingBinds.add(includePath);
  }

  if (context.composeYaml && !point.artifacts.some((artifact) => artifact.kind === "compose_yaml")) {
    await insertArtifact(
      point.id,
      "compose_yaml",
      "compose.yml",
      { projectName: context.projectName },
      executionFence,
      captureAttemptToken
    );
  }
  if (context.env && !point.artifacts.some((artifact) => artifact.kind === "env_file")) {
    await insertArtifact(
      point.id,
      "env_file",
      ".env",
      { projectName: context.projectName },
      executionFence,
      captureAttemptToken
    );
  }
}

async function loadPointProfile(point: RecoveryPointDetail) {
  const profileId = typeof point.metadata.profileId === "string"
    ? point.metadata.profileId
    : point.profileId ?? null;
  return profileId ? getRecoveryProfile(profileId) : null;
}

async function runProfileHook(hostId: string, profile: RecoveryProfile | null, phase: "pre" | "post") {
  const command = phase === "pre" ? profile?.preCaptureCommand : profile?.postCaptureCommand;
  if (!command?.trim()) return null;
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return { demo: true };
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery profile capture hooks require SSH host mode.");
  }
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 5 * 60_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Recovery ${phase}-capture hook failed`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function inspectRecoveryNetwork(hostId: string, networkName: string) {
  const snapshot = await findResource(hostId, "network", networkName);
  if (snapshot?.data && typeof snapshot.data === "object") {
    return buildNetworkManifest(snapshot.data as Record<string, unknown>, networkName);
  }
  try {
    const result = await runDocker(hostId, `docker network inspect ${shQuote(networkName)}`, 60_000);
    const parsed = JSON.parse(result.stdout || "[]");
    const inspect = Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object"
      ? parsed[0] as Record<string, unknown>
      : { Name: networkName };
    return buildNetworkManifest(inspect, networkName);
  } catch {
    return buildNetworkManifest({ Name: networkName }, networkName);
  }
}

async function collectNetworkManifests(hostId: string, containers: ReturnType<typeof buildContainerManifest>[]) {
  const names = Array.from(new Set(
    containers.flatMap((container) => container.networks).filter((name) => name && !BUILTIN_NETWORKS.has(name))
  ));
  const networks = [];
  for (const name of names) networks.push(await inspectRecoveryNetwork(hostId, name));
  return networks;
}

export async function runRecoveryCreate(
  hostId: string,
  recoveryPointId: string,
  options: {
    stopFirst?: boolean;
    restartAfterStopFirst?: boolean;
    deferRestartObligationResolution?: boolean;
    executionFence?: JobExecutionFence;
  } = {}
) {
  const executionFence = options.executionFence;
  await executionFence?.assertActive();
  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point || point.hostId !== hostId) throw new Error("Recovery point not found");

  const stopFirst = options.stopFirst
    ?? Boolean((point.metadata as Record<string, unknown>).stopFirst);
  const restartAfterStopFirst = options.restartAfterStopFirst ?? true;
  const captureAttemptToken = uuid();
  const captureAttempt: RecoveryCaptureAttempt = {
    token: captureAttemptToken,
    directory: await createRecoveryTemporaryDirectory(
      recoveryPointId,
      ".capture",
      captureAttemptToken
    )
  };
  let captureFailure: Error | null = null;

  try {
    const started = await executionQuery(
      executionFence,
      `UPDATE recovery_points
       SET status = 'running', started_at = now(), error = null,
           metadata = metadata || $2::jsonb
       WHERE id = $1
         AND metadata->>'deletionClaimToken' IS NULL
       RETURNING id`,
      [recoveryPointId, JSON.stringify({
        captureMode: stopFirst ? "stop-first" : "online",
        restartAfterStopFirst,
        captureAttemptToken
      })]
    );
    if (started.rowCount === 0) {
      throw Object.assign(new Error("Recovery point is being deleted"), { statusCode: 409 });
    }
  } catch (error) {
    await removeTrackedRecoveryTemporaryDirectory(captureAttempt.directory)
      .catch(() => undefined);
    throw error;
  }

  try {
  const context = await resolveAppContext(point.hostId, point.appIdentity);
  const profile = await loadPointProfile(point);
  const containerIds = context.containerIds.length
    ? context.containerIds
    : point.appIdentity.kind === "standalone"
      ? point.appIdentity.containerIds
      : [];

  if (!containerIds.length && !isComposeApp(point.appIdentity)) {
    throw new Error("No containers found for recovery point");
  }

  const inspects: InspectRow[] = [];
  for (const containerId of containerIds) {
    inspects.push({ id: containerId, inspect: await inspectContainer(hostId, containerId) });
  }

  const runningStates = recordRunningStates(inspects);
  const shouldStopFirst = stopFirst && wasAnyContainerRunning(runningStates);
  const restartContainerIds = containersToRestart(runningStates);
  let stoppedForBackup = false;

  try {
    if (shouldStopFirst) {
      await executionFence?.assertActive();
      const restartObligation = await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1
           AND metadata->>'captureAttemptToken' = $3
         RETURNING id`,
        [
          recoveryPointId,
          JSON.stringify({
            sourceRestartPending: true,
            sourceRestartContainerIds: restartContainerIds,
            sourceRestartRequestedAt: new Date().toISOString(),
            sourceRestartReconciliationState: "pending",
            sourceLeftStopped: true,
            sourceStoppedIds: restartContainerIds
          }),
          captureAttemptToken
        ]
      );
      assertRecoveryCaptureAttemptUpdated(restartObligation, recoveryPointId);
      try {
        await stopContainersWithRestartOnFailure(
          hostId,
          containerIds,
          restartContainerIds
        );
      } catch (stopError) {
        const restartFailedIds = (stopError as RecoveryCaptureError).restartFailedIds ?? [];
        if (!restartFailedIds.length) {
          await resolveRecoverySourceRestartObligation(
            recoveryPointId,
            {
              sourceLeftStopped: false,
              containerIds: restartContainerIds,
              resolution: "stop_not_applied"
            },
            executionFence,
            true,
            captureAttemptToken
          );
        }
        throw stopError;
      }
      stoppedForBackup = true;
    }

    await executionFence?.assertActive();
    const preHookResult = await runProfileHook(hostId, profile, "pre");
    if (preHookResult) {
      const preHook = await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1
           AND metadata->>'captureAttemptToken' = $3
         RETURNING id`,
        [
          recoveryPointId,
          JSON.stringify({ preCaptureHook: preHookResult }),
          captureAttemptToken
        ]
      );
      assertRecoveryCaptureAttemptUpdated(preHook, recoveryPointId);
    }

    const hasPotentialDesktopAlias = inspects.some(({ inspect }) =>
      buildContainerManifest(inspect).bindMounts.some((bind) =>
        bind.source.startsWith("/host_mnt/") || bind.source.startsWith("/private/")
      )
    );
    const dockerDesktopAliases = hasPotentialDesktopAlias
      ? await dockerDesktopBindAliasesAvailable(hostId)
      : false;
    await ensurePlannedArtifacts(
      point,
      inspects,
      context,
      profile,
      { dockerDesktopAliases },
      executionFence,
      captureAttemptToken
    );
    const refreshed = await loadRecoveryPoint(recoveryPointId);
    if (!refreshed) throw new Error("Recovery point not found after planning artifacts");

    const artifactManifest: Array<{ kind: string; storageKey: string; metadata: Record<string, unknown> }> = [];

    for (const artifact of refreshed.artifacts) {
      if (artifact.kind === "metadata") continue;
      artifactManifest.push({ kind: artifact.kind, storageKey: artifact.storageKey, metadata: artifact.metadata });
    }

    for (const artifact of refreshed.artifacts) {
      try {
        await executionFence?.assertActive();
        if (artifact.kind === "compose_yaml") {
          if (!context.composeYaml) {
            await updateArtifactStatus(
              artifact.id,
              "failed",
              { error: "Compose YAML unavailable" },
              executionFence,
              captureAttemptToken
            );
            continue;
          }
          const written = await writeRecoveryCaptureAttemptFile(
            recoveryPointId,
            captureAttempt,
            artifact.storageKey,
            context.composeYaml
          );
          await publishRecoveryCaptureArtifact({
            recoveryPointId,
            artifactId: artifact.id,
            storageKey: artifact.storageKey,
            attempt: captureAttempt,
            sizeBytes: written.sizeBytes,
            checksum: written.checksum,
            executionFence
          });
          continue;
        }
        if (artifact.kind === "env_file") {
          const written = await writeRecoveryCaptureAttemptFile(
            recoveryPointId,
            captureAttempt,
            artifact.storageKey,
            context.env ?? ""
          );
          await publishRecoveryCaptureArtifact({
            recoveryPointId,
            artifactId: artifact.id,
            storageKey: artifact.storageKey,
            attempt: captureAttempt,
            sizeBytes: written.sizeBytes,
            checksum: written.checksum,
            executionFence
          });
          continue;
        }
        if (artifact.kind === "volume") {
          const volumeName = String(artifact.metadata.volumeName ?? "");
          if (!volumeName) {
            await updateArtifactStatus(
              artifact.id,
              "failed",
              { error: "Missing volume name metadata" },
              executionFence,
              captureAttemptToken
            );
            continue;
          }
          await updateArtifactStatus(
            artifact.id,
            "running",
            {},
            executionFence,
            captureAttemptToken
          );
          await captureNamedVolume(
            hostId,
            recoveryPointId,
            artifact.id,
            artifact.storageKey,
            volumeName,
            captureAttempt,
            executionFence
          );
          continue;
        }
        if (artifact.kind === "host_folder") {
          const sourcePath = String(artifact.metadata.sourcePath ?? "");
          if (!sourcePath) {
            await updateArtifactStatus(
              artifact.id,
              "failed",
              { error: "Missing bind mount source path" },
              executionFence,
              captureAttemptToken
            );
            continue;
          }
          await updateArtifactStatus(
            artifact.id,
            "running",
            {},
            executionFence,
            captureAttemptToken
          );
          const excludePatterns = Array.isArray(artifact.metadata.excludePatterns)
            ? artifact.metadata.excludePatterns.map(String)
            : [];
          await captureBindMount(
            hostId,
            recoveryPointId,
            artifact.id,
            artifact.storageKey,
            sourcePath,
            captureAttempt,
            excludePatterns,
            executionFence
          );
          continue;
        }
        await updateArtifactStatus(
          artifact.id,
          "failed",
          { error: `Unsupported artifact kind: ${artifact.kind}` },
          executionFence,
          captureAttemptToken
        );
      } catch (error) {
        if (
          error instanceof Error
          && (error as { code?: unknown }).code === "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED"
        ) {
          throw error;
        }
        await updateArtifactStatus(artifact.id, "failed", {
          error: error instanceof Error ? error.message : String(error)
        }, executionFence, captureAttemptToken);
      }
    }

    const latest = await loadRecoveryPoint(recoveryPointId);
    const dockerVersions = await getDockerVersions(hostId);
    const containerManifests = inspects.map(({ inspect }) => buildContainerManifest(inspect));
    const networkManifests = await collectNetworkManifests(hostId, containerManifests);
    const manifest = buildRecoveryManifest({
      recoveryPointId,
      hostId: point.hostId,
      appIdentity: point.appIdentity,
      captureMode: stopFirst ? "stop-first" : "online",
      originalRunningState: runningStates,
      docker: dockerVersions,
      compose: {
        projectName: context.projectName,
        stackId: context.stackId,
        workingDir: context.workingDir,
        composePath: context.composePath,
        yaml: context.composeYaml,
        env: context.env
      },
      containers: containerManifests,
      networks: networkManifests,
      artifacts: (latest?.artifacts ?? [])
        .filter((artifact) => artifact.kind !== "metadata")
        .map((artifact) => ({ kind: artifact.kind, storageKey: artifact.storageKey, metadata: artifact.metadata })),
      profile: profile ?? (typeof point.metadata.profileSnapshot === "object" && point.metadata.profileSnapshot ? point.metadata.profileSnapshot as Record<string, unknown> : null)
    });

    await executionFence?.assertActive();
    const postHookResult = await runProfileHook(hostId, profile, "post");
    if (postHookResult) {
      const postHook = await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1
           AND metadata->>'captureAttemptToken' = $3
         RETURNING id`,
        [
          recoveryPointId,
          JSON.stringify({ postCaptureHook: postHookResult }),
          captureAttemptToken
        ]
      );
      assertRecoveryCaptureAttemptUpdated(postHook, recoveryPointId);
    }

    const metadataArtifact = latest?.artifacts.find((artifact) => artifact.kind === "metadata");
    const manifestKey = metadataArtifact?.storageKey ?? "manifest.json";
    await executionFence?.assertActive();
    const written = await writeRecoveryCaptureAttemptFile(
      recoveryPointId,
      captureAttempt,
      manifestKey,
      JSON.stringify(manifest, null, 2)
    );
    const metadataArtifactId = metadataArtifact?.id ?? await insertArtifact(
      recoveryPointId,
      "metadata",
      manifestKey,
      { manifestVersion: 1 },
      executionFence,
      captureAttemptToken
    );
    await publishRecoveryCaptureArtifact({
      recoveryPointId,
      artifactId: metadataArtifactId,
      storageKey: manifestKey,
      attempt: captureAttempt,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      executionFence
    });

    let remoteUploadFailures = 0;
    if (point.backupTargetId) {
      try {
        remoteUploadFailures = await uploadRecoveryArtifactsToRemote(
          recoveryPointId,
          point.backupTargetId,
          captureAttempt,
          executionFence
        );
      } catch (error) {
        if (
          error instanceof Error
          && (error as { code?: unknown }).code === "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED"
        ) {
          throw error;
        }
        remoteUploadFailures = 1;
        const message = error instanceof Error ? error.message : String(error);
        const artifactsFailed = await executionQuery(
          executionFence,
          `UPDATE recovery_artifacts
           SET error = $2,
               metadata = metadata || $3::jsonb
           WHERE recovery_point_id = $1
             AND status = 'completed'
             AND EXISTS (
               SELECT 1
               FROM recovery_points point
               WHERE point.id = recovery_artifacts.recovery_point_id
                 AND point.metadata->>'captureAttemptToken' = $4
             )
           RETURNING id`,
          [
            recoveryPointId,
            message,
            JSON.stringify({
              remoteUploadError: message,
              remoteVerified: false,
              localCacheRemoved: false
            }),
            captureAttemptToken
          ]
        );
        assertRecoveryCaptureAttemptUpdated(artifactsFailed, recoveryPointId);
        const pointFailed = await executionQuery(
          executionFence,
          `UPDATE recovery_points
           SET metadata = metadata || $2::jsonb
           WHERE id = $1
             AND metadata->>'captureAttemptToken' = $3
           RETURNING id`,
          [
            recoveryPointId,
            JSON.stringify({
              remoteUploadAttempted: true,
              remoteUploadComplete: false,
              remoteUploadFailureCount: 1,
              remoteUploadedArtifactCount: 0,
              remoteVerifiedArtifactCount: 0,
              remoteObjectKeys: [],
              remoteUploadError: message
            }),
            captureAttemptToken
          ]
        );
        assertRecoveryCaptureAttemptUpdated(pointFailed, recoveryPointId);
      }
    }

    await finalizeRecoveryPoint(
      recoveryPointId,
      captureAttemptToken,
      remoteUploadFailures,
      executionFence
    );
    if (
      stoppedForBackup
      && !restartAfterStopFirst
      && !options.deferRestartObligationResolution
    ) {
      await resolveRecoverySourceRestartObligation(
        recoveryPointId,
        {
          sourceLeftStopped: true,
          containerIds: restartContainerIds,
          resolution: "intentionally_left_stopped"
        },
        executionFence,
        false,
        captureAttemptToken
      );
    }
    const completedPoint = await loadRecoveryPoint(recoveryPointId);
    if (completedPoint && (completedPoint.status === "completed" || completedPoint.status === "partial")) {
      try {
        await executionFence?.assertActive();
        await enforceScheduledRecoveryRetention(completedPoint);
      } catch (retentionError) {
        await query(
          `UPDATE recovery_points
           SET metadata = metadata || $2::jsonb
           WHERE id = $1
             AND metadata->>'captureAttemptToken' = $3`,
          [
            recoveryPointId,
            JSON.stringify({
              retentionCleanupError: retentionError instanceof Error ? retentionError.message : String(retentionError)
            }),
            captureAttemptToken
          ]
        );
      }
    }
    return {
      recoveryPointId,
      status: (await loadRecoveryPoint(recoveryPointId))?.status ?? "completed",
      captureMode: stopFirst ? "stop-first" : "online",
      manifestKey,
      sourceLeftStopped: stoppedForBackup && !restartAfterStopFirst,
      stoppedContainerIds: stoppedForBackup && !restartAfterStopFirst
        ? restartContainerIds
        : []
    };
  } catch (error) {
    const thrown = (error instanceof Error ? error : new Error(String(error))) as RecoveryCaptureError;
    captureFailure = thrown;
    if (
      (thrown as { code?: unknown }).code === "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED"
    ) {
      throw thrown;
    }
    const restartFailedIds = thrown.restartFailedIds ?? [];
    let sourceStoppedIds: string[] = [];
    if (restartFailedIds.length) {
      sourceStoppedIds = restartFailedIds;
    } else if (stoppedForBackup && !restartAfterStopFirst) {
      sourceStoppedIds = containersToRestart(runningStates);
    }
    if (sourceStoppedIds.length) {
      thrown.sourceStoppedIds = sourceStoppedIds;
    }
    const failureMetadata = sourceStoppedIds.length
      ? {
        sourceLeftStopped: true,
        sourceStoppedIds,
        restartFailedIds
      }
      : {};
    const failureSql = `UPDATE recovery_points
      SET status = 'failed',
          error = $2,
          completed_at = now(),
          metadata = metadata || $3::jsonb
      WHERE id = $1
        AND metadata->>'captureAttemptToken' = $4
      RETURNING id`;
    const failureValues = [
      recoveryPointId,
      thrown.message,
      JSON.stringify(failureMetadata),
      captureAttemptToken
    ];
    try {
      const failureUpdate = await executionQuery(
        executionFence,
        failureSql,
        failureValues
      );
      assertRecoveryCaptureAttemptUpdated(failureUpdate, recoveryPointId);
    } catch (failureUpdateError) {
      // A lease can expire after stop-first has changed the source but before
      // the fenced failure write. Preserve its safety facts only while this
      // capture token still owns the point; a newer attempt remains authoritative.
      try {
        await query(failureSql, failureValues);
      } catch (durabilityError) {
        const aggregate = new AggregateError(
          [failureUpdateError, durabilityError],
          "Recovery capture lost its lease and could not persist stopped-source safety facts"
        ) as AggregateError & RecoveryCaptureError;
        aggregate.sourceStoppedIds = sourceStoppedIds;
        aggregate.restartFailedIds = restartFailedIds;
        throw aggregate;
      }
      const updateThrown = (failureUpdateError instanceof Error
        ? failureUpdateError
        : new Error(String(failureUpdateError))) as RecoveryCaptureError;
      captureFailure = updateThrown;
      if (sourceStoppedIds.length) {
        updateThrown.sourceStoppedIds = sourceStoppedIds;
      }
      throw updateThrown;
    }
    throw thrown;
  } finally {
    if (stoppedForBackup && restartAfterStopFirst) {
      try {
        await startContainersOneByOne(hostId, restartContainerIds);
      } catch (restartError) {
        const restartThrown = (
          restartError instanceof Error ? restartError : new Error(String(restartError))
        ) as RecoveryCaptureError;
        const restartTargets = restartContainerIds;
        const restartFailedIds = Array.from(new Set(
          restartThrown.restartFailedIds?.length
            ? restartThrown.restartFailedIds
            : restartTargets
        ));
        const restartFailure = `Restart failed: ${restartThrown.message}`;
        const restartMetadata = {
          restartFailure: restartThrown.message,
          restartFailedIds,
          sourceLeftStopped: restartFailedIds.length > 0,
          sourceStoppedIds: restartFailedIds
        };
        const restartUpdateSql = `UPDATE recovery_points
          SET status = CASE WHEN status IN ('completed', 'partial') THEN 'partial' ELSE status END,
              error = CASE
                WHEN COALESCE(error, '') = '' THEN $2
                ELSE error || '; ' || $2
              END,
              metadata = metadata || $3::jsonb
          WHERE id = $1
            AND metadata->>'captureAttemptToken' = $4
          RETURNING id`;
        const restartUpdateValues = [
          recoveryPointId,
          restartFailure,
          JSON.stringify(restartMetadata),
          captureAttemptToken
        ];
        try {
          const restartUpdate = await executionQuery(
            executionFence,
            restartUpdateSql,
            restartUpdateValues
          );
          assertRecoveryCaptureAttemptUpdated(restartUpdate, recoveryPointId);
        } catch (restartUpdateError) {
          try {
            await query(restartUpdateSql, restartUpdateValues);
          } catch (durabilityError) {
            const aggregate = new AggregateError(
              [restartUpdateError, durabilityError],
              "Recovery source restart failed after lease loss and stopped-source safety facts could not be persisted"
            ) as AggregateError & RecoveryCaptureError;
            aggregate.restartFailedIds = restartFailedIds;
            aggregate.sourceStoppedIds = restartFailedIds;
            throw aggregate;
          }
          const updateThrown = (
            restartUpdateError instanceof Error
              ? restartUpdateError
              : new Error(String(restartUpdateError))
          ) as RecoveryCaptureError;
          updateThrown.restartFailedIds = restartFailedIds;
          updateThrown.sourceStoppedIds = restartFailedIds;
          throw updateThrown;
        }

        const jobError = (
          captureFailure
            ? new Error(`${captureFailure.message}; ${restartFailure}`)
            : restartThrown
        ) as RecoveryCaptureError;
        jobError.restartFailedIds = restartFailedIds;
        jobError.sourceStoppedIds = restartFailedIds;
        throw jobError;
      }
      await resolveRecoverySourceRestartObligation(
        recoveryPointId,
        {
          sourceLeftStopped: false,
          containerIds: restartContainerIds,
          resolution: "restarted"
        },
        executionFence,
        true,
        captureAttemptToken
      );
    }
  }
  } finally {
    try {
      if (
        captureFailure
        && (captureFailure as { code?: unknown }).code === "RECOVERY_CAPTURE_RECONCILIATION_REQUIRED"
      ) {
        await preserveTrackedRecoveryTemporaryDirectory(
          captureAttempt.directory,
          {
            recoveryPointId,
            attemptToken: captureAttemptToken
          }
        );
      } else {
        await removeTrackedRecoveryTemporaryDirectory(captureAttempt.directory);
      }
    } catch (cleanupError) {
      await query(
        `UPDATE recovery_points
         SET metadata = metadata || $3::jsonb
         WHERE id = $1
           AND metadata->>'captureAttemptToken' = $2`,
        [
          recoveryPointId,
          captureAttemptToken,
          JSON.stringify({
            captureAttemptCleanupError: cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          })
        ]
      ).catch(() => undefined);
    }
  }
}

export async function runRecoveryVerify(hostId: string, recoveryPointId: string, executionFence?: JobExecutionFence) {
  await executionFence?.assertActive();
  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point || point.hostId !== hostId) throw new Error("Recovery point not found");

  const manifestArtifact = point.artifacts.find((artifact) => artifact.kind === "metadata");
  if (!manifestArtifact) throw new Error("Recovery manifest artifact not found");

  const manifestRaw = await readRecoveryArtifact(point, manifestArtifact);
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as { artifacts?: Array<{ storageKey: string }> };
  const failures: string[] = [];
  let backupTarget: Awaited<ReturnType<typeof loadWorkerBackupTarget>> | null = null;
  let backupTargetLoadError: unknown = null;
  if (point.backupTargetId) {
    try {
      backupTarget = await loadWorkerBackupTarget(point.backupTargetId);
    } catch (error) {
      backupTargetLoadError = error;
    }
  }

  for (const artifact of point.artifacts) {
    await executionFence?.assertActive();
    if (artifact.status !== "completed") {
      failures.push(`${artifact.kind}:${artifact.storageKey} status=${artifact.status}`);
      continue;
    }
    try {
      await withRecoveryArtifactLocalPath(point, artifact, async (filePath) => {
        const checksum = await hashFile(filePath);
        if (artifact.checksum && artifact.checksum !== checksum) {
          failures.push(`${artifact.storageKey} checksum mismatch`);
        }
      });
    } catch (error) {
      failures.push(`${artifact.storageKey} missing (${error instanceof Error ? error.message : String(error)})`);
    }

    if (point.backupTargetId) {
      const remoteKey = artifact.metadata.remoteObjectKey;
      const remoteExplicitlyUnverified = artifact.metadata.remoteVerified === false;
      if (backupTargetLoadError) {
        failures.push(`${artifact.storageKey} remote target unavailable`);
      } else if (backupTarget?.kind === "local") {
        // A local target intentionally has no remote object locator.
      } else if (
        !backupTarget
        || (backupTarget.kind === "s3" && !backupTarget.s3)
        || (backupTarget.kind === "rclone" && !backupTarget.rclone)
      ) {
        failures.push(`${artifact.storageKey} remote target is invalid`);
      } else if (remoteExplicitlyUnverified) {
        failures.push(`${artifact.storageKey} remote verification failed`);
      } else if (typeof remoteKey !== "string" || !remoteKey.trim()) {
        failures.push(`${artifact.storageKey} remote locator missing`);
      } else {
        try {
          const head = await headRemoteArtifact(backupTarget, remoteKey);
          if (artifact.sizeBytes != null && head.sizeBytes != null && artifact.sizeBytes !== head.sizeBytes) {
            failures.push(`${artifact.storageKey} remote size mismatch`);
          }
          if (artifact.checksum && head.checksum && artifact.checksum !== head.checksum) {
            failures.push(`${artifact.storageKey} remote checksum mismatch`);
          }
          await withRecoveryArtifactRemotePath(point, artifact, async (filePath) => {
            const remoteChecksum = await hashFile(filePath);
            if (artifact.checksum && artifact.checksum !== remoteChecksum) {
              throw new Error("downloaded remote checksum mismatch");
            }
          });
        } catch (error) {
          failures.push(`${artifact.storageKey} remote verify failed (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }

  const verifyStatus = failures.length ? "failed" : "completed";
  await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [recoveryPointId, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      verifyStatus,
      verifyFailures: failures,
      manifestArtifactCount: manifest.artifacts?.length ?? point.artifacts.length
    })]
  );

  if (failures.length) {
    throw new Error(`Recovery verification failed: ${failures.join("; ")}`);
  }

  return { recoveryPointId, verifyStatus, artifactCount: point.artifacts.length };
}

/** Backward-compatible alias */
export const runRecoveryPointCapture = runRecoveryCreate;
