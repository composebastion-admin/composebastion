import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  backupListQuerySchema,
  paginatedResponse,
  sanitizeUrlDiagnosticText,
  type Backup,
  type BackupHealthSummary,
  type DockerActionRequest,
  type OperationJob
} from "@composebastion/shared";
import type { PoolClient } from "pg";
import { v4 as uuid } from "uuid";
import { env } from "../config/env.js";
import { query, withTransaction } from "../db/pool.js";
import { shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { getHostForWorker } from "./hosts.js";
import { mapBackup } from "./mappers.js";
import {
  assertHostPathCanBeRestored,
  buildHostPathCaptureCommand,
  buildHostPathRestoreCommand,
  normalizeHostSourcePath,
  normalizeHostTargetPath
} from "./backupHostPaths.js";
import { notifyBackupScheduleFailure, recordBackupScheduleResult } from "./backupFailureAlerts.js";
import {
  createBackupDecryptTransform,
  createBackupEncryptTransform,
  backupEncryptionKeyId,
  backupEncryptionKeyFingerprint,
  type BackupEncryption
} from "./backupEncryption.js";
import {
  loadWorkerBackupTarget,
  assertBackupTargetS3EndpointAllowed,
  type WorkerBackupTarget
} from "./recoveryBackupTargets.js";
import { assertBackupTargetUsableForReference } from "./backupTargetLifecycle.js";
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
import { hashFile } from "./recoveryStorage.js";
import { pipeReadableToSshCommand, runSshCommand, streamSshCommandToFile } from "./ssh.js";
import { sanitizeDockerName } from "./recoveryRestoreUtils.js";
import { enqueueJobInTransaction, notifyJobQueued, type JobExecutionFence } from "./jobs.js";
import type { DockerMutationScope } from "./dockerMutationScope.js";
import {
  buildRecoveryTargetOperationScopeKeys,
  lockRecoveryOperationAdmission,
  persistRecoveryDockerMutationScopes,
  type RecoveryAdmissionOperationKind
} from "./recoveryOperationAdmission.js";
import {
  beginRecoveryRestoreAttempt,
  markRecoveryRestoreAttemptAwaitingDisposition,
  markRecoveryRestoreAttemptCleaned,
  markRecoveryRestoreAttemptCleanupPending,
  markRecoveryRestoreResourceObserved,
  registerRecoveryRestoreResource
} from "./recoveryRestoreAttempts.js";
import {
  buildAcquireOwnedRemoteDirectoryCommand,
  buildCleanupOwnedRemoteDirectoryCommand,
  isOwnedRemoteDirectorySafetyRefusal
} from "./remoteOwnedDirectory.js";

export const BACKUP_DRILL_ROOT = "/var/lib/composebastion/drills";
const BACKUP_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKUP_PROOF_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_HEALTH_ATTENTION_LIMIT = 20;
const BACKUP_TEMPORARY_DIRECTORY_PREFIXES = [
  ".composebastion-capture-",
  ".composebastion-verify-",
  ".composebastion-remote-verify-",
  ".composebastion-hydrate-"
] as const;
export const BACKUP_TEMPORARY_DIRECTORY_MAX_AGE_MS = 15 * 60_000;
export const BACKUP_TEMPORARY_DIRECTORY_HEARTBEAT_MS = 60_000;
const BACKUP_DELETION_CLAIM_HEARTBEAT_MS = 30_000;
export const BACKUP_DELETION_RECONCILIATION_QUIESCENCE_MS =
  11 * 60_000;
const BACKUP_TEMPORARY_DIRECTORY_LEASE = ".composebastion-active";
const BACKUP_CAPTURE_RECONCILIATION_MARKER = ".composebastion-reconciliation-required";
const RESTORE_ATTEMPT_LABEL =
  "com.composebastion.recovery.restore-attempt";
const RESTORE_SCOPE_LABEL =
  "com.composebastion.recovery.restore-scope";
const activeBackupTemporaryDirectories = new Map<string, NodeJS.Timeout>();

type BackupCaptureAttempt = {
  token: string;
  directory: string;
  artifactPath: string;
};

async function executionCheckpoint(fence?: JobExecutionFence) {
  await fence?.assertActive();
}

async function executionQuery(
  fence: JobExecutionFence | undefined,
  text: string,
  values: unknown[]
) {
  if (!fence) return query(text, values);
  return fence.withActiveLease((client) => client.query(text, values));
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

export function backupFileName(id: string, label: string) {
  return `${id}-${sanitizeFilePart(label)}.tar.gz`;
}

export function safeBackupPath(fileName: string) {
  const root = path.resolve(env.BACKUP_DIR);
  const candidate = path.resolve(root, fileName);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Backup path escapes backup directory");
  }
  return candidate;
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function backupTemporaryDirectoryPrefix(name: string) {
  return BACKUP_TEMPORARY_DIRECTORY_PREFIXES.find((prefix) => {
    if (!name.startsWith(prefix)) return false;
    const suffix = name.slice(prefix.length);
    return suffix.length > 0 && /^[A-Za-z0-9._-]+$/.test(suffix);
  }) ?? null;
}

async function trackBackupTemporaryDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const leasePath = path.join(resolved, BACKUP_TEMPORARY_DIRECTORY_LEASE);
  try {
    await writeFile(leasePath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (leaseError) {
    try {
      await rm(resolved, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [leaseError, cleanupError],
        `Could not initialize a backup temporary-directory lease (${errorMessage(leaseError)}) or remove the unleased directory (${errorMessage(cleanupError)})`
      );
    }
    throw leaseError;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(leasePath, now, now).catch((error) => {
      if (!isMissingFile(error)) {
        console.warn("Failed to refresh a backup temporary-directory lease", {
          directory: resolved,
          error: errorMessage(error)
        });
      }
    });
  }, BACKUP_TEMPORARY_DIRECTORY_HEARTBEAT_MS);
  heartbeat.unref();
  activeBackupTemporaryDirectories.set(resolved, heartbeat);
  return resolved;
}

export async function cleanupStaleBackupTemporaryDirectories(options: {
  root?: string;
  maxAgeMs?: number;
  nowMs?: number;
} = {}) {
  const root = path.resolve(options.root ?? env.BACKUP_DIR);
  const maxAgeMs = options.maxAgeMs ?? BACKUP_TEMPORARY_DIRECTORY_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) {
    throw new Error("Invalid backup temporary-directory cleanup age");
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return { removed: 0, skipped: 0 };
    throw error;
  }

  let removed = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!backupTemporaryDirectoryPrefix(entry.name)) continue;
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root || activeBackupTemporaryDirectories.has(candidate)) {
      skipped += 1;
      continue;
    }

    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || (currentUid !== null && stats.uid !== currentUid)
    ) {
      skipped += 1;
      continue;
    }

    let freshestMtimeMs = stats.mtimeMs;
    try {
      const reconciliationMarker = await lstat(
        path.join(candidate, BACKUP_CAPTURE_RECONCILIATION_MARKER)
      );
      // A marker is a fail-closed durability boundary. Even an unexpected
      // marker type must never cause the only ambiguous capture artifact to
      // be swept.
      if (
        !reconciliationMarker.isFile()
        || reconciliationMarker.isSymbolicLink()
        || (currentUid !== null && reconciliationMarker.uid !== currentUid)
      ) {
        skipped += 1;
        continue;
      }
      skipped += 1;
      continue;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    try {
      const leaseStats = await lstat(path.join(candidate, BACKUP_TEMPORARY_DIRECTORY_LEASE));
      if (
        !leaseStats.isFile()
        || leaseStats.isSymbolicLink()
        || (currentUid !== null && leaseStats.uid !== currentUid)
      ) {
        skipped += 1;
        continue;
      }
      freshestMtimeMs = Math.max(freshestMtimeMs, leaseStats.mtimeMs);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (nowMs - freshestMtimeMs < maxAgeMs) {
      skipped += 1;
      continue;
    }
    try {
      await rm(candidate, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return { removed, skipped };
}

function backupLabel(backup: Pick<Backup, "kind" | "volumeName" | "sourcePath">) {
  return backup.kind === "host_path" ? backup.sourcePath ?? "host path" : backup.volumeName ?? "volume";
}

function backupRemoteObjectKey(backup: Backup) {
  return backup.remoteObjectKey || null;
}

function backupRemoteObjectKeys(backup: Backup) {
  const keys = [
    backup.remoteObjectKey,
    backup.metadata.orphanRemoteObjectKey,
    ...(Array.isArray(backup.metadata.orphanRemoteObjectKeys)
      ? backup.metadata.orphanRemoteObjectKeys
      : [])
  ];
  return [...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0))];
}

function normalizeBackupEncryption(value?: string | null): BackupEncryption {
  return value === "app_secret" ? "app_secret" : "none";
}

function backupEncryptionFingerprint(encryption: BackupEncryption) {
  return encryption === "app_secret" ? backupEncryptionKeyFingerprint : null;
}

function backupEncryptionActiveKeyId(encryption: BackupEncryption) {
  return encryption === "app_secret" ? backupEncryptionKeyId : null;
}

export function shortBackupDrillId(value: string) {
  const compact = value.replace(/-/g, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return compact || "drill";
}

export function buildBackupDrillVolumeName(backupId: string, drillId: string) {
  const backupPart = sanitizeDockerName(shortBackupDrillId(backupId), 24);
  const drillPart = sanitizeDockerName(shortBackupDrillId(drillId), 24);
  return `drill-${backupPart}-${drillPart}`.slice(0, 80);
}

function normalizeBackupDrillRoot(root = BACKUP_DRILL_ROOT) {
  const normalized = path.posix.normalize(root.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (!normalized.startsWith("/")) throw new Error("Backup drill root must be an absolute path");
  return normalized;
}

export function assertAllowedBackupDrillPath(targetPath: string, root = BACKUP_DRILL_ROOT) {
  const normalizedRoot = normalizeBackupDrillRoot(root);
  const normalized = path.posix.normalize(targetPath.replace(/\\/g, "/"));
  if (normalized !== normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized;
  }
  throw new Error(`Backup drill path ${normalized} is not allowed. Use ${normalizedRoot}.`);
}

export function buildBackupDrillPath(backupId: string, drillId: string, root = BACKUP_DRILL_ROOT) {
  return assertAllowedBackupDrillPath(
    path.posix.join(normalizeBackupDrillRoot(root), shortBackupDrillId(backupId), shortBackupDrillId(drillId)),
    root
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function safeDiagnosticMessage(error: unknown) {
  return String(sanitizeUrlDiagnosticText(errorMessage(error)));
}

export async function runBackupDrillWithTeardown<T>(
  work: () => Promise<T>,
  teardown: () => Promise<void>
) {
  let result: T | null = null;
  let workError: unknown = null;
  try {
    result = await work();
  } catch (error) {
    workError = error;
  }

  let cleanupError: string | null = null;
  try {
    await teardown();
  } catch (error) {
    cleanupError = errorMessage(error);
  }

  if (workError) {
    if (cleanupError && workError instanceof Error) {
      (workError as Error & { cleanupError?: string }).cleanupError = cleanupError;
    }
    throw workError;
  }

  return { result: result as T, cleanupError };
}

function pipeReadable(input: NodeJS.ReadableStream, transforms: Array<Transform | null>) {
  let current = input;
  for (const transform of transforms) {
    if (!transform) continue;
    current.once("error", (error) => {
      transform.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    current = current.pipe(transform);
  }
  return current;
}

function createStoredBackupReadStream(backup: Backup, localPath: string) {
  return pipeReadable(createReadStream(localPath), [
    createBackupDecryptTransform(backup.encryption)
  ]);
}

async function writeBackupBytes(localPath: string, content: Buffer | string, encryption: BackupEncryption) {
  await mkdir(path.dirname(localPath), { recursive: true });
  const transform = createBackupEncryptTransform(encryption);
  if (transform) {
    await pipeline(Readable.from([content]), transform, createWriteStream(localPath));
  } else {
    await writeFile(localPath, content);
  }
  const fileStat = await stat(localPath);
  return fileStat.size;
}

export async function assertBackupTargetUsable(backupTargetId?: string | null) {
  if (!backupTargetId) return null;
  const result = await query<any>("SELECT * FROM backup_targets WHERE id = $1", [backupTargetId]);
  const target = result.rows[0];
  if (!target) {
    throw Object.assign(new Error("Backup target not found"), { statusCode: 409 });
  }
  if (!target.enabled) {
    throw Object.assign(new Error("Backup target is disabled"), { statusCode: 409 });
  }
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw Object.assign(
      new Error("Regular backups currently support S3 and rclone backup targets only"),
      { statusCode: 409 }
    );
  }
  await assertBackupTargetS3EndpointAllowed(target);
  return target.id as string;
}

type BackupRecordOptions = {
  backupTargetId?: string | null;
  metadata?: Record<string, unknown>;
  fileName?: string;
  encryption?: BackupEncryption;
};

type PreparedBackupRecordBase = {
  id: string;
  hostId: string;
  fileName: string;
  backupTargetId: string | null;
  encryption: BackupEncryption;
  encryptionKeyId: string | null;
  encryptionKeyFingerprint: string | null;
  metadata: Record<string, unknown>;
};

export type PreparedBackupRecord = PreparedBackupRecordBase & (
  | { kind: "volume"; volumeName: string; sourcePath: null }
  | { kind: "host_path"; volumeName: null; sourcePath: string }
);

function backupDockerMutationScope(
  hostId: string,
  kind: "volume" | "host-path",
  value: string
): DockerMutationScope {
  return {
    type: kind === "volume"
      ? "volume.create"
      : "host.mkdir",
    hostIds: [hostId],
    targets: [{ hostId, kind, value }]
  };
}

async function admitBackupDockerScopes(
  client: PoolClient,
  kind: RecoveryAdmissionOperationKind,
  scopes: {
    source?: readonly DockerMutationScope[];
    target?: readonly DockerMutationScope[];
  }
) {
  const source = [...(scopes.source ?? [])];
  const target = [...(scopes.target ?? [])];
  await lockRecoveryOperationAdmission(client, {
    kind,
    sourceDockerScopes: source,
    targetDockerScopes: target,
    sourceScopeKeys: source.flatMap(
      buildRecoveryTargetOperationScopeKeys
    ),
    targetScopeKeys: target.flatMap(
      buildRecoveryTargetOperationScopeKeys
    )
  });
}

async function persistBackupDockerScopes(
  client: PoolClient,
  jobId: string,
  scopes: {
    source?: readonly DockerMutationScope[];
    target?: readonly DockerMutationScope[];
  }
) {
  await persistRecoveryDockerMutationScopes(
    client,
    jobId,
    scopes
  );
}

function preparedBackupSourceScope(
  prepared: PreparedBackupRecord
) {
  return backupDockerMutationScope(
    prepared.hostId,
    prepared.kind === "volume"
      ? "volume"
      : "host-path",
    prepared.kind === "volume"
      ? prepared.volumeName
      : prepared.sourcePath
  );
}

export async function prepareBackupRecord(
  hostId: string,
  volumeName: string,
  options: BackupRecordOptions = {}
): Promise<PreparedBackupRecord> {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  const backupTargetId = await assertBackupTargetUsable(options.backupTargetId);
  const encryption = normalizeBackupEncryption(options.encryption);
  const id = uuid();
  const fileName = options.fileName ?? backupFileName(id, volumeName);
  return {
    id,
    hostId,
    kind: "volume",
    volumeName,
    sourcePath: null,
    fileName,
    backupTargetId,
    encryption,
    encryptionKeyId: backupEncryptionActiveKeyId(encryption),
    encryptionKeyFingerprint: backupEncryptionFingerprint(encryption),
    metadata: options.metadata ?? {}
  };
}

export async function prepareHostPathBackupRecord(
  hostId: string,
  sourcePath: string,
  options: BackupRecordOptions = {}
): Promise<PreparedBackupRecord> {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  const normalized = normalizeHostSourcePath(sourcePath);
  const backupTargetId = await assertBackupTargetUsable(options.backupTargetId);
  const encryption = normalizeBackupEncryption(options.encryption);
  const id = uuid();
  const label = normalized.replace(/^\//, "").replace(/\//g, "_") || "host_path";
  const fileName = options.fileName ?? backupFileName(id, `host-path-${label}`);
  return {
    id,
    hostId,
    kind: "host_path",
    volumeName: null,
    sourcePath: normalized,
    fileName,
    backupTargetId,
    encryption,
    encryptionKeyId: backupEncryptionActiveKeyId(encryption),
    encryptionKeyFingerprint: backupEncryptionFingerprint(encryption),
    metadata: options.metadata ?? {}
  };
}

async function persistPreparedBackupRecord(prepared: PreparedBackupRecord, client?: PoolClient): Promise<Backup> {
  if (!client) {
    return withTransaction((transactionClient) => persistPreparedBackupRecord(prepared, transactionClient));
  }
  await assertBackupTargetUsableForReference(client, prepared.backupTargetId, {
    allowedKinds: ["s3", "rclone"]
  });
  const sql =
    `INSERT INTO backups
      (id, host_id, kind, volume_name, source_path, file_name, status, backup_target_id, encryption, encryption_key_id, encryption_key_fingerprint, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11)
     RETURNING *`;
  const values = [
    prepared.id,
    prepared.hostId,
    prepared.kind,
    prepared.volumeName,
    prepared.sourcePath,
    prepared.fileName,
    prepared.backupTargetId,
    prepared.encryption,
    prepared.encryptionKeyId,
    prepared.encryptionKeyFingerprint,
    prepared.metadata
  ];
  const result = await client.query(sql, values);
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create backup record");
  return mapBackup(row);
}

export async function insertPreparedBackupRecord(client: PoolClient, prepared: PreparedBackupRecord) {
  return persistPreparedBackupRecord(prepared, client);
}

export async function insertPreparedBackupJob(
  client: PoolClient,
  prepared: PreparedBackupRecord,
  createdBy?: string | null
) {
  const backup = await insertPreparedBackupRecord(client, prepared);
  const sourceScope = preparedBackupSourceScope(prepared);
  await admitBackupDockerScopes(
    client,
    "capture",
    { source: [sourceScope] }
  );
  const job = await enqueueJobInTransaction(
    client,
    prepared.kind === "host_path"
      ? {
          type: "hostPath.backup",
          hostId: prepared.hostId,
          payload: { backupId: backup.id, sourcePath: prepared.sourcePath }
        }
      : {
          type: "volume.backup",
          hostId: prepared.hostId,
          payload: { backupId: backup.id, volumeName: prepared.volumeName }
        },
    createdBy
  );
  await persistBackupDockerScopes(
    client,
    job.id,
    { source: [sourceScope] }
  );
  return { backup, job };
}

export async function createBackupRecord(hostId: string, volumeName: string, options: BackupRecordOptions = {}) {
  return persistPreparedBackupRecord(await prepareBackupRecord(hostId, volumeName, options));
}

export async function createHostPathBackupRecord(hostId: string, sourcePath: string, options: BackupRecordOptions = {}) {
  return persistPreparedBackupRecord(await prepareHostPathBackupRecord(hostId, sourcePath, options));
}

async function createPreparedBackupJobs(
  preparedRecords: PreparedBackupRecord[],
  createdBy?: string | null,
  onCreated?: (
    client: PoolClient,
    result: { backups: Backup[]; jobs: OperationJob[] }
  ) => Promise<void>
) {
  const result = await withTransaction(async (client) => {
    const backups: Backup[] = [];
    const jobs: OperationJob[] = [];
    for (const prepared of preparedRecords) {
      const { backup, job } = await insertPreparedBackupJob(
        client,
        prepared,
        createdBy
      );
      backups.push(backup);
      jobs.push(job);
    }
    const created = { backups, jobs };
    await onCreated?.(client, created);
    return created;
  });
  await Promise.all(result.jobs.map((job) => notifyJobQueued(job.id)));
  return result;
}

export async function createBackupWithJob(
  hostId: string,
  volumeName: string,
  options: BackupRecordOptions = {},
  createdBy?: string | null,
  onCreated?: (
    client: PoolClient,
    result: { backup: Backup; job: OperationJob }
  ) => Promise<void>
) {
  const result = await createPreparedBackupJobs(
    [await prepareBackupRecord(hostId, volumeName, options)],
    createdBy,
    onCreated
      ? (client, created) => onCreated(client, {
          backup: created.backups[0]!,
          job: created.jobs[0]!
        })
      : undefined
  );
  return { backup: result.backups[0]!, job: result.jobs[0]! };
}

export async function createHostPathBackupWithJob(
  hostId: string,
  sourcePath: string,
  options: BackupRecordOptions = {},
  createdBy?: string | null,
  onCreated?: (
    client: PoolClient,
    result: { backup: Backup; job: OperationJob }
  ) => Promise<void>
) {
  const result = await createPreparedBackupJobs(
    [await prepareHostPathBackupRecord(hostId, sourcePath, options)],
    createdBy,
    onCreated
      ? (client, created) => onCreated(client, {
          backup: created.backups[0]!,
          job: created.jobs[0]!
        })
      : undefined
  );
  return { backup: result.backups[0]!, job: result.jobs[0]! };
}

export async function createVolumeBackupsWithJobs(
  hostId: string,
  volumeNames: string[],
  createdBy?: string | null,
  onCreated?: (
    client: PoolClient,
    result: { backups: Backup[]; jobs: OperationJob[] }
  ) => Promise<void>
) {
  const prepared = await Promise.all(volumeNames.map((volumeName) => prepareBackupRecord(hostId, volumeName)));
  return createPreparedBackupJobs(prepared, createdBy, onCreated);
}

export async function createVolumeCloneWithJob(input: {
  sourceHostId: string;
  targetHostId: string;
  sourceVolumeName: string;
  targetVolumeName: string;
  overwrite?: boolean;
}, createdBy?: string | null, onCreated?: (
  client: PoolClient,
  result: { backup: Backup; job: OperationJob }
) => Promise<void>) {
  if (input.overwrite) {
    throw Object.assign(
      new Error(
        "Overwrite clone restore is disabled because merging into an existing volume cannot be rolled back safely"
      ),
      { statusCode: 409 }
    );
  }
  const prepared = await prepareBackupRecord(input.sourceHostId, input.sourceVolumeName, {
    metadata: {
      operation: "volume.clone",
      targetHostId: input.targetHostId,
      targetVolumeName: input.targetVolumeName
    }
  });
  const result = await withTransaction(async (client) => {
    const backup = await insertPreparedBackupRecord(client, prepared);
    const sourceScope = backupDockerMutationScope(
      input.sourceHostId,
      "volume",
      input.sourceVolumeName
    );
    const targetScope = backupDockerMutationScope(
      input.targetHostId,
      "volume",
      input.targetVolumeName
    );
    await admitBackupDockerScopes(
      client,
      "migration",
      {
        source: [sourceScope],
        target: [targetScope]
      }
    );
    const job = await enqueueJobInTransaction(
      client,
      {
        type: "volume.clone",
        hostId: input.sourceHostId,
        payload: {
          backupId: backup.id,
          targetHostId: input.targetHostId,
          sourceVolumeName: input.sourceVolumeName,
          targetVolumeName: input.targetVolumeName,
          overwrite: input.overwrite ?? false
        }
      },
      createdBy
    );
    await persistBackupDockerScopes(
      client,
      job.id,
      {
        source: [sourceScope],
        target: [targetScope]
      }
    );
    await onCreated?.(client, { backup, job });
    return { backup, job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}

export async function getBackup(id: string) {
  const result = await query("SELECT * FROM backups WHERE id = $1", [id]);
  return result.rows[0] ? mapBackup(result.rows[0]) : null;
}

function backupHasDeletionClaim(metadata: Record<string, unknown>) {
  return typeof metadata.deletionClaimToken === "string"
    && metadata.deletionClaimToken.length > 0;
}

async function enqueueBackupOperation(
  backupId: string,
  prepare: (backup: Backup) => {
    action: DockerActionRequest;
    admissionKind?: RecoveryAdmissionOperationKind;
    sourceScopes?: DockerMutationScope[];
    targetScopes?: DockerMutationScope[];
  },
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: { backup: Backup; job: OperationJob }
  ) => Promise<void>
) {
  const result = await withTransaction(async (client) => {
    const selected = await client.query(
      "SELECT * FROM backups WHERE id = $1 FOR UPDATE",
      [backupId]
    );
    if (!selected.rows[0]) return null;
    const backup = mapBackup(selected.rows[0]);
    if (backupHasDeletionClaim(backup.metadata)) {
      throw Object.assign(
        new Error("A backup being deleted cannot accept new operations"),
        { statusCode: 409 }
      );
    }
    const prepared = prepare(backup);
    const source = prepared.sourceScopes ?? [];
    const target = prepared.targetScopes ?? [];
    if (source.length || target.length) {
      await admitBackupDockerScopes(
        client,
        prepared.admissionKind
          ?? (target.length ? "restore" : "capture"),
        { source, target }
      );
    }
    const job = await enqueueJobInTransaction(
      client,
      prepared.action,
      createdBy ?? undefined
    );
    if (source.length || target.length) {
      await persistBackupDockerScopes(
        client,
        job.id,
        { source, target }
      );
    }
    const queued = { backup, job };
    await onQueued?.(client, queued);
    return queued;
  });
  if (!result) return null;
  await notifyJobQueued(result.job.id);
  return result;
}

export async function enqueueVolumeRestoreJob(input: {
  backupId: string;
  targetHostId: string;
  targetVolumeName: string;
  overwrite: boolean;
}, createdBy?: string | null, onQueued?: (
  client: PoolClient,
  result: { backup: Backup; job: OperationJob }
) => Promise<void>) {
  if (input.overwrite) {
    throw Object.assign(
      new Error(
        "Overwrite restore is disabled because merging into an existing volume cannot be rolled back safely"
      ),
      { statusCode: 409 }
    );
  }
  return enqueueBackupOperation(input.backupId, (backup) => {
    if (backup.kind !== "volume") {
      throw Object.assign(
        new Error("Use the host-path restore endpoint for host-path backups"),
        { statusCode: 400 }
      );
    }
    return {
      admissionKind: "restore",
      targetScopes: [
        backupDockerMutationScope(
          input.targetHostId,
          "volume",
          input.targetVolumeName
        )
      ],
      action: {
        type: "volume.restore",
        hostId: input.targetHostId,
        payload: {
          backupId: input.backupId,
          targetVolumeName: input.targetVolumeName,
          overwrite: false
        }
      }
    };
  }, createdBy, onQueued);
}

export async function enqueueHostPathRestoreJob(input: {
  backupId: string;
  targetHostId: string;
  targetPath: string;
  overwrite: boolean;
}, createdBy?: string | null, onQueued?: (
  client: PoolClient,
  result: { backup: Backup; job: OperationJob }
) => Promise<void>) {
  if (input.overwrite) {
    throw Object.assign(
      new Error(
        "Overwrite restore is disabled because merging into an existing host path cannot be rolled back safely"
      ),
      { statusCode: 409 }
    );
  }
  return enqueueBackupOperation(input.backupId, (backup) => {
    if (backup.kind !== "host_path") {
      throw Object.assign(
        new Error("Use the volume restore endpoint for volume backups"),
        { statusCode: 400 }
      );
    }
    const targetPath =
      normalizeHostTargetPath(input.targetPath);
    return {
      admissionKind: "restore",
      targetScopes: [
        backupDockerMutationScope(
          input.targetHostId,
          "host-path",
          targetPath
        )
      ],
      action: {
        type: "hostPath.restore",
        hostId: input.targetHostId,
        payload: {
          backupId: input.backupId,
          targetPath,
          overwrite: false
        }
      }
    };
  }, createdBy, onQueued);
}

export async function enqueueBackupVerifyJob(
  backupId: string,
  testArchive: boolean,
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: { backup: Backup; job: OperationJob }
  ) => Promise<void>
) {
  return enqueueBackupOperation(backupId, (backup) => ({
    action: {
      type: "backup.verify",
      hostId: backup.hostId,
      payload: { backupId, testArchive }
    }
  }), createdBy, onQueued);
}

export async function enqueueBackupDrillJob(
  backupId: string,
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: { backup: Backup; job: OperationJob }
  ) => Promise<void>
) {
  const drillId = randomUUID();
  return enqueueBackupOperation(backupId, (backup) => {
    const target = backup.kind === "volume"
      ? backupDockerMutationScope(
          backup.hostId,
          "volume",
          buildBackupDrillVolumeName(
            backup.id,
            drillId
          )
        )
      : backupDockerMutationScope(
          backup.hostId,
          "host-path",
          buildBackupDrillPath(
            backup.id,
            drillId
          )
        );
    return {
      admissionKind: "restore",
      targetScopes: [target],
      action: {
        type: "backup.drill",
        hostId: backup.hostId,
        payload: { backupId, drillId }
      }
    };
  }, createdBy, onQueued);
}

export async function listBackups(input: unknown = {}) {
  const queryInput = backupListQuerySchema.parse(input);
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (queryInput.hostId) {
    values.push(queryInput.hostId);
    clauses.push(`host_id = $${values.length}`);
  }
  if (queryInput.kind) {
    values.push(queryInput.kind);
    clauses.push(`kind = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(queryInput.limit, queryInput.offset);
  const limitIndex = values.length - 1;
  const offsetIndex = values.length;
  const [rows, total] = await Promise.all([
    query(
      `SELECT * FROM backups
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      values
    ),
    query<{ count: string }>(`SELECT count(*)::text AS count FROM backups ${where}`, values.slice(0, values.length - 2))
  ]);
  return paginatedResponse(rows.rows.map(mapBackup), Number(total.rows[0]?.count ?? 0), queryInput);
}

function backupHealthStatus(input: {
  staleSuccessfulBackup: boolean;
  recentFailureCount: number;
  neverVerifiedCount: number;
  neverDrilledCount: number;
  staleVerifiedCount: number;
  staleDrilledCount: number;
}) {
  if (input.staleSuccessfulBackup || input.recentFailureCount > 0) return "critical" as const;
  if (
    input.neverVerifiedCount > 0
    || input.neverDrilledCount > 0
    || input.staleVerifiedCount > 0
    || input.staleDrilledCount > 0
  ) {
    return "warning" as const;
  }
  return "healthy" as const;
}

function worstBackupHealthStatus(statuses: Array<"healthy" | "warning" | "critical">) {
  if (statuses.includes("critical")) return "critical" as const;
  if (statuses.includes("warning")) return "warning" as const;
  return "healthy" as const;
}

type BackupHealthAttentionReason =
  | "failed"
  | "partial"
  | "never_verified"
  | "never_drilled"
  | "stale_verified"
  | "stale_drilled";

export type BackupHealthAttentionRow = {
  id: string;
  host_id: string;
  host_name: string | null;
  host_hostname: string | null;
  kind: "volume" | "host_path";
  volume_name: string | null;
  source_path: string | null;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  created_at: Date | string;
  completed_at: Date | string | null;
  verified_at: Date | string | null;
  last_drill_at: Date | string | null;
};

function isoDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function attentionLabel(row: BackupHealthAttentionRow) {
  return row.kind === "host_path" ? row.source_path ?? "Host path" : row.volume_name ?? "Volume";
}

function attentionAction(reason: BackupHealthAttentionReason) {
  switch (reason) {
    case "failed":
      return "Review the failure and rerun the backup.";
    case "partial":
      return "Fix the remote target, then rerun the backup or verify the local artifact.";
    case "never_verified":
      return "Run backup verification.";
    case "stale_verified":
      return "Run backup verification again.";
    case "never_drilled":
      return "Run a restore drill.";
    case "stale_drilled":
      return "Run another restore drill.";
  }
}

function attentionSeverity(reason: BackupHealthAttentionReason) {
  return reason === "failed" || reason === "partial" ? "critical" as const : "warning" as const;
}

function attentionRank(status: "healthy" | "warning" | "critical") {
  if (status === "critical") return 0;
  if (status === "warning") return 1;
  return 2;
}

export function buildBackupHealthAttentionItems(rows: BackupHealthAttentionRow[], now = new Date()) {
  const proofCutoff = now.getTime() - BACKUP_PROOF_STALE_MS;
  const items: BackupHealthSummary["attention"] = [];

  function add(row: BackupHealthAttentionRow, reason: BackupHealthAttentionReason) {
    const severity = attentionSeverity(reason);
    const createdAt = isoDate(row.created_at)!;
    const completedAt = isoDate(row.completed_at);
    const basis = completedAt ?? createdAt;
    items.push({
      backupId: row.id,
      hostId: row.host_id,
      hostName: row.host_name ?? row.host_hostname ?? row.host_id,
      kind: row.kind,
      label: attentionLabel(row),
      status: row.status,
      severity,
      reason,
      recommendedAction: attentionAction(reason),
      createdAt,
      completedAt,
      ageMs: basis ? Math.max(0, now.getTime() - new Date(basis).getTime()) : null
    });
  }

  for (const row of rows) {
    if (row.status === "failed") {
      add(row, "failed");
      continue;
    }
    if (row.status !== "completed" && row.status !== "partial") continue;
    if (row.status === "partial") add(row, "partial");

    const verifiedAt = row.verified_at ? new Date(row.verified_at).getTime() : null;
    if (verifiedAt === null) {
      add(row, "never_verified");
    } else if (verifiedAt < proofCutoff) {
      add(row, "stale_verified");
    }

    const lastDrillAt = row.last_drill_at ? new Date(row.last_drill_at).getTime() : null;
    if (lastDrillAt === null) {
      add(row, "never_drilled");
    } else if (lastDrillAt < proofCutoff) {
      add(row, "stale_drilled");
    }
  }

  return items
    .sort((left, right) => {
      const severity = attentionRank(left.severity) - attentionRank(right.severity);
      if (severity !== 0) return severity;
      return (right.ageMs ?? 0) - (left.ageMs ?? 0);
    })
    .slice(0, BACKUP_HEALTH_ATTENTION_LIMIT);
}

export async function getBackupHealthSummary(now = new Date()): Promise<BackupHealthSummary> {
  const [hostsResult, scheduleResult, aggregateResult, attentionResult] = await Promise.all([
    query<{ id: string; name: string | null; hostname: string | null }>(
      "SELECT id, name, hostname FROM docker_hosts ORDER BY name ASC"
    ),
    query<{ host_id: string; schedule_interval_ms: string | null }>(
      `SELECT host_id, MIN(interval_ms)::text AS schedule_interval_ms
       FROM backup_schedules
       WHERE enabled = true
       GROUP BY host_id`
    ),
    query<any>(
      `SELECT host_id,
              MAX(completed_at) FILTER (WHERE status IN ('completed', 'partial')) AS newest_successful_backup_at,
              COUNT(*) FILTER (
                WHERE status IN ('failed', 'partial')
                  AND created_at >= now() - ($1::double precision * interval '1 millisecond')
              )::int AS recent_failure_count,
              COALESCE(SUM(size_bytes) FILTER (WHERE status IN ('completed', 'partial')), 0)::text AS total_size_bytes,
              COUNT(*) FILTER (WHERE status IN ('completed', 'partial') AND verified_at IS NULL)::int AS never_verified_count,
              COUNT(*) FILTER (WHERE status IN ('completed', 'partial') AND last_drill_at IS NULL)::int AS never_drilled_count,
              COUNT(*) FILTER (
                WHERE status IN ('completed', 'partial')
                  AND verified_at IS NOT NULL
                  AND verified_at < now() - ($2::double precision * interval '1 millisecond')
              )::int AS stale_verified_count,
              COUNT(*) FILTER (
                WHERE status IN ('completed', 'partial')
                  AND last_drill_at IS NOT NULL
                  AND last_drill_at < now() - ($2::double precision * interval '1 millisecond')
              )::int AS stale_drilled_count
       FROM backups
       GROUP BY host_id`,
      [BACKUP_HEALTH_WINDOW_MS, BACKUP_PROOF_STALE_MS]
    ),
    query<BackupHealthAttentionRow>(
      `SELECT b.id,
              b.host_id,
              docker_hosts.name AS host_name,
              docker_hosts.hostname AS host_hostname,
              b.kind,
              b.volume_name,
              b.source_path,
              b.status,
              b.created_at,
              b.completed_at,
              b.verified_at,
              b.last_drill_at
       FROM backups b
       LEFT JOIN docker_hosts ON docker_hosts.id = b.host_id
       WHERE b.status IN ('completed', 'partial', 'failed')
       ORDER BY COALESCE(b.completed_at, b.created_at) DESC
       LIMIT 200`
    )
  ]);

  const scheduleIntervals = new Map(
    scheduleResult.rows.map((row) => [row.host_id, row.schedule_interval_ms ? Number(row.schedule_interval_ms) : null])
  );
  const aggregates = new Map(aggregateResult.rows.map((row: any) => [row.host_id, row]));

  const hosts = hostsResult.rows.map((host) => {
    const aggregate = aggregates.get(host.id) as any | undefined;
    const newest = aggregate?.newest_successful_backup_at
      ? new Date(aggregate.newest_successful_backup_at).toISOString()
      : null;
    const newestAge = newest ? Math.max(0, now.getTime() - new Date(newest).getTime()) : null;
    const scheduleInterval = scheduleIntervals.get(host.id) ?? null;
    const staleSuccessfulBackup = scheduleInterval !== null && (newestAge === null || newestAge > scheduleInterval);
    const recentFailureCount = Number(aggregate?.recent_failure_count ?? 0);
    const neverVerifiedCount = Number(aggregate?.never_verified_count ?? 0);
    const neverDrilledCount = Number(aggregate?.never_drilled_count ?? 0);
    const staleVerifiedCount = Number(aggregate?.stale_verified_count ?? 0);
    const staleDrilledCount = Number(aggregate?.stale_drilled_count ?? 0);
    const status = backupHealthStatus({
      staleSuccessfulBackup,
      recentFailureCount,
      neverVerifiedCount,
      neverDrilledCount,
      staleVerifiedCount,
      staleDrilledCount
    });
    return {
      hostId: host.id,
      hostName: host.name ?? host.hostname ?? host.id,
      newestSuccessfulBackupAt: newest,
      newestSuccessfulBackupAgeMs: newestAge,
      scheduleIntervalMs: scheduleInterval,
      staleSuccessfulBackup,
      recentFailureCount,
      totalSizeBytes: Number(aggregate?.total_size_bytes ?? 0),
      neverVerifiedCount,
      neverDrilledCount,
      staleVerifiedCount,
      staleDrilledCount,
      status
    };
  });

  const newestOverall = hosts
    .map((host) => host.newestSuccessfulBackupAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const overallAge = newestOverall ? Math.max(0, now.getTime() - new Date(newestOverall).getTime()) : null;
  const overall = {
    hostId: null,
    hostName: "All hosts",
    newestSuccessfulBackupAt: newestOverall,
    newestSuccessfulBackupAgeMs: overallAge,
    scheduleIntervalMs: null,
    staleSuccessfulBackup: hosts.some((host) => host.staleSuccessfulBackup),
    recentFailureCount: hosts.reduce((total, host) => total + host.recentFailureCount, 0),
    totalSizeBytes: hosts.reduce((total, host) => total + host.totalSizeBytes, 0),
    neverVerifiedCount: hosts.reduce((total, host) => total + host.neverVerifiedCount, 0),
    neverDrilledCount: hosts.reduce((total, host) => total + host.neverDrilledCount, 0),
    staleVerifiedCount: hosts.reduce((total, host) => total + host.staleVerifiedCount, 0),
    staleDrilledCount: hosts.reduce((total, host) => total + host.staleDrilledCount, 0),
    status: worstBackupHealthStatus(hosts.map((host) => host.status))
  };

  return {
    windowMs: BACKUP_HEALTH_WINDOW_MS,
    proofStaleMs: BACKUP_PROOF_STALE_MS,
    overall,
    hosts,
    attention: buildBackupHealthAttentionItems(attentionResult.rows, now)
  };
}

async function deleteBackupRemoteObject(backup: Backup) {
  const objectKeys = backupRemoteObjectKeys(backup);
  if (!objectKeys.length) return [];
  if (!backup.backupTargetId) {
    throw new Error(`Backup ${backup.id} has a remote object but no backup target`);
  }
  const target = await loadWorkerBackupTarget(backup.backupTargetId);
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error(`Backup ${backup.id} remote target does not support deletes`);
  }
  await assertBackupTargetS3EndpointAllowed(target);
  for (const objectKey of objectKeys) {
    await deleteRemoteArtifact(target, objectKey);
  }
  return objectKeys;
}

function deletionTimestampIsQuiescent(
  value: unknown,
  nowMs: number,
  quiescenceMs: number
) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed <= nowMs - quiescenceMs;
}

async function finishClaimedBackupDeletion(
  backup: Backup,
  deletionClaimToken: string,
  reconciliationToken?: string
) {
  const localPath = safeBackupPath(backup.fileName);
  const heartbeat = () => {
    const now = new Date().toISOString();
    const metadata = reconciliationToken
      ? {
          deletionClaimedAt: now,
          deletionReconciliationStartedAt: now
        }
      : { deletionClaimedAt: now };
    return query(
      `UPDATE backups
       SET metadata = metadata || $3::jsonb
       WHERE id = $1
         AND metadata->>'deletionClaimToken' = $2
         AND (
           $4::text IS NOT NULL
             AND metadata->>'deletionReconciliationToken' = $4
           OR $4::text IS NULL
             AND metadata->>'deletionReconciliationToken' IS NULL
         )`,
      [
        backup.id,
        deletionClaimToken,
        JSON.stringify(metadata),
        reconciliationToken ?? null
      ]
    );
  };
  const claimHeartbeat = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, BACKUP_DELETION_CLAIM_HEARTBEAT_MS);
  claimHeartbeat.unref();
  try {
    await deleteBackupRemoteObject(backup);
    try {
      await unlink(localPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const deleted = await withTransaction(
      async (client) => {
        const owner = await client.query(
          "SELECT * FROM backups WHERE id = $1 FOR UPDATE",
          [backup.id]
        );
        if (!owner.rows[0]) return { rowCount: 0 };
        const metadata = mapBackup(owner.rows[0]).metadata;
        const ownsClaim =
          metadata.deletionClaimToken === deletionClaimToken;
        const ownsReconciliation = reconciliationToken
          ? metadata.deletionReconciliationToken
              === reconciliationToken
          : typeof metadata.deletionReconciliationToken
              !== "string";
        if (!ownsClaim || !ownsReconciliation) {
          return { rowCount: 0 };
        }
        const pending = await client.query(
          `SELECT id
           FROM recovery_restore_attempts
           WHERE backup_id = $1
             AND status NOT IN ('retained', 'cleaned')
           LIMIT 1`,
          [backup.id]
        );
        if (pending.rows[0]) {
          throw Object.assign(
            new Error(
              "Backup deletion lost its cleanup-safe state; restore reconciliation is required"
            ),
            { statusCode: 409 }
          );
        }
        await client.query(
          `DELETE FROM recovery_restore_resources
           WHERE attempt_id IN (
             SELECT id
             FROM recovery_restore_attempts
             WHERE backup_id = $1
               AND status IN ('retained', 'cleaned')
           )`,
          [backup.id]
        );
        await client.query(
          `DELETE FROM recovery_restore_attempts
           WHERE backup_id = $1
             AND status IN ('retained', 'cleaned')`,
          [backup.id]
        );
        return client.query(
          `DELETE FROM backups
           WHERE id = $1
             AND metadata->>'deletionClaimToken' = $2`,
          [backup.id, deletionClaimToken]
        );
      }
    );
    if (deleted.rowCount !== 1) {
      throw Object.assign(
        new Error(
          "Backup deletion lost its claim after storage cleanup; database reconciliation is required"
        ),
        { statusCode: 409 }
      );
    }
  } finally {
    clearInterval(claimHeartbeat);
  }
}

export async function deleteBackup(
  id: string,
  onDeletionClaimed?: (
    client: PoolClient,
    backup: Backup
  ) => Promise<void>
) {
  const deletionClaimToken = randomUUID();
  const backup = await withTransaction(async (client) => {
    const selected = await client.query(
      "SELECT * FROM backups WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!selected.rows[0]) return null;
    const lockedBackup = mapBackup(selected.rows[0]);
    if (lockedBackup.status === "queued" || lockedBackup.status === "running") {
      throw Object.assign(
        new Error("A queued or running backup cannot be deleted"),
        { statusCode: 409 }
      );
    }
    // A heartbeat timestamp is diagnostic only. Automatically stealing an old
    // claim could leave the prior deleter running against newly admitted work.
    if (backupHasDeletionClaim(lockedBackup.metadata)) {
      throw Object.assign(
        new Error(
          "A backup deletion claim already exists; reconciliation is required before another deletion attempt"
        ),
        { statusCode: 409 }
      );
    }
    const activeOperation = await client.query(
      `SELECT 1
       FROM operation_jobs
       WHERE status IN ('queued', 'running')
         AND payload->>'backupId' = $1
       LIMIT 1`,
      [id]
    );
    if (activeOperation.rows.length) {
      throw Object.assign(
        new Error("A backup with an active operation cannot be deleted"),
        { statusCode: 409 }
      );
    }
    const restoreAttempts = await client.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM recovery_restore_attempts
       WHERE backup_id = $1
       ORDER BY created_at ASC`,
      [id]
    );
    const pendingAttempt =
      restoreAttempts.rows.find((attempt) =>
        attempt.status !== "retained"
        && attempt.status !== "cleaned"
      );
    if (pendingAttempt) {
      throw Object.assign(
        new Error(
          "A backup with a restore attempt awaiting disposition or cleanup cannot be deleted"
        ),
        {
          statusCode: 409,
          activeAttemptId: pendingAttempt.id
        }
      );
    }
    await client.query(
      `UPDATE backups
       SET metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [
        id,
        JSON.stringify({
          deletionClaimToken,
          deletionClaimedAt: new Date().toISOString()
        })
      ]
    );
    // Required audit/intention writes belong to the claim transaction. Once
    // it commits, every failure must leave the claim in place because remote
    // or local deletion may already have happened.
    await onDeletionClaimed?.(client, lockedBackup);
    return lockedBackup;
  });
  if (!backup) return null;
  await finishClaimedBackupDeletion(
    backup,
    deletionClaimToken
  );
  return backup;
}

export async function reconcileClaimedBackupDeletions(
  limit = 10,
  now = new Date()
) {
  const claimed = await withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT *
       FROM backups
       WHERE NULLIF(metadata->>'deletionClaimToken', '') IS NOT NULL
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))]
    );
    const candidates: Array<{
      backup: Backup;
      deletionClaimToken: string;
      reconciliationToken: string;
    }> = [];
    for (const row of selected.rows) {
      const backup = mapBackup(row);
      const metadata = backup.metadata;
      if (
        !deletionTimestampIsQuiescent(
          metadata.deletionClaimedAt,
          now.getTime(),
          BACKUP_DELETION_RECONCILIATION_QUIESCENCE_MS
        )
      ) {
        continue;
      }
      if (
        typeof metadata.deletionReconciliationToken === "string"
        && !deletionTimestampIsQuiescent(
          metadata.deletionReconciliationStartedAt,
          now.getTime(),
          BACKUP_DELETION_RECONCILIATION_QUIESCENCE_MS
        )
      ) {
        continue;
      }
      const active = await client.query(
        `SELECT 1
         FROM operation_jobs
         WHERE status IN ('queued', 'running')
           AND payload->>'backupId' = $1
         LIMIT 1`,
        [backup.id]
      );
      if (active.rows[0]) continue;
      const pending = await client.query(
        `SELECT 1
         FROM recovery_restore_attempts
         WHERE backup_id = $1
           AND status NOT IN ('retained', 'cleaned')
         LIMIT 1`,
        [backup.id]
      );
      if (pending.rows[0]) continue;
      const deletionClaimToken = String(
        metadata.deletionClaimToken
      );
      const reconciliationToken = randomUUID();
      const startedAt = now.toISOString();
      const updated = await client.query(
        `UPDATE backups
         SET metadata = metadata || $3::jsonb
         WHERE id = $1
           AND metadata->>'deletionClaimToken' = $2
         RETURNING *`,
        [
          backup.id,
          deletionClaimToken,
          JSON.stringify({
            deletionClaimedAt: startedAt,
            deletionReconciliationToken:
              reconciliationToken,
            deletionReconciliationStartedAt: startedAt
          })
        ]
      );
      if (updated.rows[0]) {
        candidates.push({
          backup: mapBackup(updated.rows[0]),
          deletionClaimToken,
          reconciliationToken
        });
      }
    }
    return candidates;
  });
  let deleted = 0;
  let failed = 0;
  for (const candidate of claimed) {
    try {
      await finishClaimedBackupDeletion(
        candidate.backup,
        candidate.deletionClaimToken,
        candidate.reconciliationToken
      );
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    checked: claimed.length,
    deleted,
    failed
  };
}

async function verifyBackupFile(backup: Backup, filePath: string) {
  const fileStat = await stat(filePath);
  if (backup.sizeBytes != null && fileStat.size !== backup.sizeBytes) {
    throw new Error(`Backup ${backup.fileName} size mismatch: expected ${backup.sizeBytes}, got ${fileStat.size}`);
  }
  if (backup.checksum) {
    const checksum = await hashFile(filePath);
    if (checksum !== backup.checksum) {
      throw new Error(`Backup ${backup.fileName} checksum mismatch`);
    }
  }
  return { sizeBytes: fileStat.size };
}

type AcquiredBackupArtifact = {
  localPath: string;
  temporary: boolean;
  cleanup: () => Promise<void>;
};

async function removeTrackedBackupTemporaryDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const heartbeat = activeBackupTemporaryDirectories.get(resolved);
  if (heartbeat) clearInterval(heartbeat);
  activeBackupTemporaryDirectories.delete(resolved);
  try {
    await rm(resolved, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function releaseTrackedBackupTemporaryDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const heartbeat = activeBackupTemporaryDirectories.get(resolved);
  if (heartbeat) clearInterval(heartbeat);
  activeBackupTemporaryDirectories.delete(resolved);
}

async function preserveBackupCaptureAttempt(
  attempt: BackupCaptureAttempt,
  evidence: {
    reason?: "capture_commit_outcome_unknown" | "capture_commit_not_committed";
    backupId: string;
    sizeBytes: number;
    checksum: string;
    remoteObjectKey: string | null;
    backupTargetId?: string | null;
    remoteBackend?: "s3" | "rclone" | null;
  }
) {
  const resolved = path.resolve(attempt.directory);
  const markerPath = path.join(resolved, BACKUP_CAPTURE_RECONCILIATION_MARKER);
  try {
    await writeFile(
      markerPath,
      `${JSON.stringify({
        reason: evidence.reason ?? "capture_commit_outcome_unknown",
        backupId: evidence.backupId,
        attemptToken: attempt.token,
        artifactPath: attempt.artifactPath,
        sizeBytes: evidence.sizeBytes,
        checksum: evidence.checksum,
        remoteObjectKey: evidence.remoteObjectKey,
        backupTargetId: evidence.backupTargetId ?? null,
        remoteBackend: evidence.remoteBackend ?? null,
        recordedAt: new Date().toISOString()
      })}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (!(
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EEXIST"
    )) {
      throw error;
    }
    const marker = await lstat(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) {
      throw new Error("Backup capture reconciliation marker is not a safe file");
    }
  }
  // The persisted marker, rather than an in-process timer, now protects this
  // directory across worker restarts.
  releaseTrackedBackupTemporaryDirectory(resolved);
}

async function acquireBackupLocalArtifact(backup: Backup): Promise<AcquiredBackupArtifact> {
  const localPath = safeBackupPath(backup.fileName);
  let localVerificationError: unknown = null;
  try {
    await verifyBackupFile(backup, localPath);
    return {
      localPath,
      temporary: false,
      cleanup: async () => undefined
    };
  } catch (error) {
    if (!isMissingFile(error)) localVerificationError = error;
  }

  const objectKey = backupRemoteObjectKey(backup);
  if (!objectKey || !backup.backupTargetId) {
    if (localVerificationError) throw localVerificationError;
    throw new Error(`Backup ${backup.fileName} is missing locally and has no remote copy`);
  }

  const target = await loadWorkerBackupTarget(backup.backupTargetId);
  await assertBackupTargetS3EndpointAllowed(target);
  const remoteOnly = backup.metadata.localCachePolicy === "remote_only";
  if (!remoteOnly) {
    await downloadRemoteArtifactAtomically(target, objectKey, localPath);
    await verifyBackupFile(backup, localPath);
    return {
      localPath,
      temporary: false,
      cleanup: async () => undefined
    };
  }

  await mkdir(env.BACKUP_DIR, { recursive: true });
  const temporaryDirectory = await trackBackupTemporaryDirectory(
    await mkdtemp(path.join(env.BACKUP_DIR, ".composebastion-hydrate-"))
  );
  const temporaryPath = path.join(temporaryDirectory, "artifact");
  try {
    await downloadRemoteArtifactAtomically(target, objectKey, temporaryPath);
    await verifyBackupFile(backup, temporaryPath);
  } catch (operationError) {
    try {
      await removeTrackedBackupTemporaryDirectory(temporaryDirectory);
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Remote backup hydration failed (${errorMessage(operationError)}) and its temporary directory could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw operationError;
  }
  let cleanupPromise: Promise<void> | null = null;
  const removeStaleLocalArtifact = localVerificationError !== null;
  return {
    localPath: temporaryPath,
    temporary: true,
    cleanup: async () => {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          await removeTrackedBackupTemporaryDirectory(temporaryDirectory);
          if (removeStaleLocalArtifact) {
            await rm(localPath, { force: true });
          }
        })();
      }
      return cleanupPromise;
    }
  };
}

async function withBackupLocalArtifact<T>(
  backup: Backup,
  work: (localPath: string) => Promise<T>
): Promise<T> {
  const acquired = await acquireBackupLocalArtifact(backup);
  let operationCompleted = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    operationResult = await work(acquired.localPath);
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await acquired.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (!operationCompleted) {
    if (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Backup operation failed (${errorMessage(operationError)}) and its hydrated temporary artifact could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw operationError;
  }
  if (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      `Backup operation completed but its hydrated temporary artifact could not be removed (${errorMessage(cleanupError)})`
    );
  }
  return operationResult;
}

export async function getBackupDownloadStream(
  id: string,
  onAuthorized?: (
    client: PoolClient,
    backup: Backup
  ) => Promise<void>
) {
  const backup = onAuthorized
    ? await withTransaction(async (client) => {
        const result = await client.query(
          "SELECT * FROM backups WHERE id = $1 FOR KEY SHARE",
          [id]
        );
        if (!result.rows[0]) return null;
        const lockedBackup = mapBackup(result.rows[0]);
        await onAuthorized(client, lockedBackup);
        return lockedBackup;
      })
    : await getBackup(id);
  if (!backup) return null;
  const acquired = await acquireBackupLocalArtifact(backup);
  try {
    const stream = createStoredBackupReadStream(backup, acquired.localPath);
    if (acquired.temporary) {
      const cleanup = () => {
        void acquired.cleanup().catch((error) => {
          console.warn("Failed to clean a hydrated remote-only backup download", {
            backupId: backup.id,
            error: errorMessage(error)
          });
        });
      };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
    }
    return { backup, stream };
  } catch (operationError) {
    try {
      await acquired.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Backup download setup failed (${errorMessage(operationError)}) and its hydrated temporary artifact could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw operationError;
  }
}

class BackupRemoteVerificationError extends Error {
  readonly cleanupTarget!: WorkerBackupTarget;

  constructor(
    readonly verificationError: string,
    cleanupTarget: WorkerBackupTarget,
    readonly orphanRemoteObject: {
      key: string;
      backend: "s3" | "rclone";
      cleanupError: string;
    } | null = null,
    readonly phase: "upload" | "verification" = "verification",
    readonly remoteObjectDeleted = false
  ) {
    const prefix = phase === "upload" ? "Remote upload failed" : "Remote verification failed";
    super(orphanRemoteObject
      ? `${prefix}: ${verificationError}; unverified object cleanup failed: ${orphanRemoteObject.cleanupError}`
      : `${prefix}: ${verificationError}`);
    this.name = "BackupRemoteVerificationError";
    // Credentials are required for exact-object compensation, but must not
    // become enumerable Error diagnostics or structured log fields.
    Object.defineProperty(this, "cleanupTarget", {
      configurable: false,
      enumerable: false,
      value: cleanupTarget,
      writable: false
    });
  }
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
    remoteObjectDeletedAfterAmbiguousUpload: boolean;
    orphanRemoteObject: {
      key: string;
      backend: "s3" | "rclone";
      cleanupError: string;
    } | null;
  };
}

async function uploadBackupArtifactToRemote(
  backup: Backup,
  localPath: string,
  checksum: string,
  captureAttemptToken: string
) {
  if (!backup.backupTargetId) return null;
  const target = await loadWorkerBackupTarget(backup.backupTargetId);
  if (!target.enabled) throw new Error("Backup target is disabled");
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error("Backup target does not support remote backup artifacts");
  }
  await assertBackupTargetS3EndpointAllowed(target);
  const remoteStorageKey = path.posix.join(
    "attempts",
    captureAttemptToken,
    backup.fileName
  );
  const expectedRemoteObjectKey = buildRemoteObjectKey(
    target,
    backup.id,
    remoteStorageKey
  );
  const writeIntent = await beginRemoteArtifactWriteIntent({
    ownerKind: "backup",
    ownerId: backup.id,
    backupTargetId: backup.backupTargetId,
    objectKey: expectedRemoteObjectKey,
    backend: target.kind,
    attemptToken: captureAttemptToken,
    target
  });
  let uploaded: Awaited<ReturnType<typeof uploadRemoteArtifact>>;
  try {
    uploaded = await uploadRemoteArtifact({
      target,
      namespaceId: backup.id,
      storageKey: remoteStorageKey,
      localPath,
      checksum
    });
  } catch (error) {
    const ambiguousUpload = remoteArtifactUploadFailure(error);
    if (ambiguousUpload) {
      if (ambiguousUpload.remoteObjectDeletedAfterAmbiguousUpload) {
        try {
          await clearRemoteArtifactWriteIntent(writeIntent);
        } catch (intentCleanupError) {
          throw new BackupRemoteVerificationError(
            safeDiagnosticMessage(ambiguousUpload.uploadError),
            target,
            {
              key: expectedRemoteObjectKey,
              backend: target.kind,
              cleanupError: safeDiagnosticMessage(intentCleanupError)
            },
            "upload",
            true
          );
        }
      } else {
        await releaseRemoteArtifactWriteIntent(
          writeIntent,
          ambiguousUpload.orphanRemoteObject?.cleanupError ?? ambiguousUpload.uploadError
        );
      }
      throw new BackupRemoteVerificationError(
        safeDiagnosticMessage(ambiguousUpload.uploadError),
        target,
        ambiguousUpload.orphanRemoteObject
          ? {
            ...ambiguousUpload.orphanRemoteObject,
            cleanupError: safeDiagnosticMessage(
              ambiguousUpload.orphanRemoteObject.cleanupError
            )
          }
          : null,
        "upload",
        ambiguousUpload.remoteObjectDeletedAfterAmbiguousUpload
      );
    }
    await releaseRemoteArtifactWriteIntent(writeIntent, error);
    throw error;
  }
  if (!uploaded) {
    await releaseRemoteArtifactWriteIntent(
      writeIntent,
      new Error("Remote backup target returned no upload locator")
    );
    return null;
  }

  try {
    if (
      uploaded.remoteObjectKey !== expectedRemoteObjectKey
      || uploaded.remoteBackend !== target.kind
    ) {
      throw new Error("remote backup target returned an unexpected object locator");
    }
    // PUT/copy completion and echoed object metadata are not proof that the
    // stored body can be restored. Download and hash the exact object before
    // publishing its locator or removing a remote-only local copy.
    const [localFile, remote] = await Promise.all([
      stat(localPath),
      headRemoteArtifact(target, uploaded.remoteObjectKey)
    ]);
    if (remote.sizeBytes === null) {
      throw new Error("remote object did not report its size");
    }
    if (remote.sizeBytes !== localFile.size) {
      throw new Error(`remote size mismatch: expected ${localFile.size}, got ${remote.sizeBytes}`);
    }
    if (remote.checksum && remote.checksum !== checksum) {
      throw new Error("remote checksum mismatch");
    }
    const downloaded = await downloadAndVerifyRemoteBackupArtifact({
      target,
      objectKey: uploaded.remoteObjectKey,
      expectedSizeBytes: localFile.size,
      expectedChecksum: checksum,
      temporaryPrefix: ".composebastion-verify-"
    });
    const verified = {
      remoteObjectKey: uploaded.remoteObjectKey,
      remoteBackend: uploaded.remoteBackend,
      remoteSizeBytes: remote.sizeBytes,
      remoteEtag: remote.etag ?? uploaded.remoteEtag,
      remoteChecksum: downloaded.checksum,
      remoteDeclaredChecksum: remote.checksum,
      remoteVerifiedAt: new Date().toISOString(),
      localCachePolicy: target.localCachePolicy,
      cleanupTarget: target
    };
    return verified;
  } catch (verificationError) {
    const verificationMessage = errorMessage(verificationError);
    try {
      await deleteRemoteArtifact(target, uploaded.remoteObjectKey);
      if (uploaded.remoteObjectKey === writeIntent.objectKey) {
        await clearRemoteArtifactWriteIntent(writeIntent);
      } else {
        await releaseRemoteArtifactWriteIntent(writeIntent, verificationError);
      }
    } catch (cleanupError) {
      await releaseRemoteArtifactWriteIntent(writeIntent, cleanupError).catch(
        () => undefined
      );
      throw new BackupRemoteVerificationError(
        verificationMessage,
        target,
        {
          key: uploaded.remoteObjectKey,
          backend: uploaded.remoteBackend,
          cleanupError: safeDiagnosticMessage(cleanupError)
        }
      );
    }
    throw new BackupRemoteVerificationError(
      verificationMessage,
      target
    );
  }
}

async function downloadAndVerifyRemoteBackupArtifact(input: {
  target: Awaited<ReturnType<typeof loadWorkerBackupTarget>>;
  objectKey: string;
  expectedSizeBytes: number | null;
  expectedChecksum: string | null;
  temporaryPrefix: string;
}) {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  const verificationDirectory = await trackBackupTemporaryDirectory(
    await mkdtemp(path.join(env.BACKUP_DIR, input.temporaryPrefix))
  );
  const downloadedPath = path.join(verificationDirectory, "artifact");
  let verificationCompleted = false;
  let verificationResult!: { sizeBytes: number; checksum: string };
  let verificationError: unknown;
  try {
    await downloadRemoteArtifactAtomically(input.target, input.objectKey, downloadedPath);
    const downloadedFile = await stat(downloadedPath);
    if (input.expectedSizeBytes !== null && downloadedFile.size !== input.expectedSizeBytes) {
      throw new Error(
        `downloaded remote size mismatch: expected ${input.expectedSizeBytes}, got ${downloadedFile.size}`
      );
    }
    const downloadedChecksum = await hashFile(downloadedPath);
    if (input.expectedChecksum && downloadedChecksum !== input.expectedChecksum) {
      throw new Error("downloaded remote checksum mismatch");
    }
    verificationResult = {
      sizeBytes: downloadedFile.size,
      checksum: downloadedChecksum
    };
    verificationCompleted = true;
  } catch (error) {
    verificationError = error;
  }

  let cleanupError: unknown;
  try {
    await removeTrackedBackupTemporaryDirectory(verificationDirectory);
  } catch (error) {
    cleanupError = error;
  }
  if (!verificationCompleted) {
    if (cleanupError) {
      throw new AggregateError(
        [verificationError, cleanupError],
        `Remote backup verification failed (${errorMessage(verificationError)}) and its temporary directory could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw verificationError;
  }
  if (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      `Remote backup verification completed but its temporary directory could not be removed (${errorMessage(cleanupError)})`
    );
  }
  return verificationResult;
}

async function recordUncommittedRemoteBackupOrphan(input: {
  backupId: string;
  captureAttemptToken: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  cleanupTarget: WorkerBackupTarget;
  commitError: unknown;
  cleanupError: unknown;
}) {
  await recordRemoteArtifactOrphan({
    ownerKind: "backup",
    ownerId: input.backupId,
    backupTargetId: input.backupTargetId,
    objectKey: input.objectKey,
    backend: input.backend,
    attemptToken: input.captureAttemptToken,
    target: input.cleanupTarget,
    cleanupError: input.cleanupError
  });
  const result = await query<{ id: string }>(
    `UPDATE backups
     SET metadata = metadata || jsonb_build_object(
       'orphanRemoteObjectKey', $2::text,
       'orphanRemoteObjectKeys', (
         SELECT COALESCE(jsonb_agg(orphan_key), '[]'::jsonb)
         FROM (
           SELECT DISTINCT orphan_key
           FROM jsonb_array_elements_text(
             (
               CASE
                 WHEN jsonb_typeof(backups.metadata->'orphanRemoteObjectKeys') = 'array'
                   THEN backups.metadata->'orphanRemoteObjectKeys'
                 ELSE '[]'::jsonb
               END
             )
             || (
               CASE
                 WHEN NULLIF(backups.metadata->>'orphanRemoteObjectKey', '') IS NOT NULL
                   THEN jsonb_build_array(backups.metadata->>'orphanRemoteObjectKey')
                 ELSE '[]'::jsonb
               END
             )
             || jsonb_build_array($2::text)
           ) AS orphan_keys(orphan_key)
         ) unique_orphan_keys
       ),
       'orphanRemoteBackend', $3::text,
       'orphanBackupTargetId', $4::text,
       'orphanCleanupError', $5::text,
       'remoteCommitError', $6::text
     )
     WHERE id = $1
       AND metadata->>'backupCaptureAttemptToken' = $7
     RETURNING id`,
    [
      input.backupId,
      input.objectKey,
      input.backend,
      input.backupTargetId,
      safeDiagnosticMessage(input.cleanupError),
      safeDiagnosticMessage(input.commitError),
      input.captureAttemptToken
    ]
  );
  // The independent orphan row is authoritative for cleanup. Metadata is
  // additive operator evidence only and may legitimately miss after a
  // successor token or deletion claim wins.
  return Boolean(result.rows[0]);
}

async function compensateUncommittedRemoteBackup(input: {
  backupId: string;
  captureAttemptToken: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  cleanupTarget: WorkerBackupTarget;
  commitError: unknown;
}) {
  let cleanupError: unknown;
  try {
    await assertBackupTargetS3EndpointAllowed(input.cleanupTarget);
    await deleteRemoteArtifact(input.cleanupTarget, input.objectKey);
    if (!await clearRemoteArtifactWriteIntent({
      ownerKind: "backup",
      ownerId: input.backupId,
      backupTargetId: input.backupTargetId,
      objectKey: input.objectKey,
      backend: input.backend,
      attemptToken: input.captureAttemptToken
    })) {
      throw new Error(
        "Compensated remote backup object did not have its durable write intent"
      );
    }
    return;
  } catch (error) {
    cleanupError = error;
  }

  try {
    await recordUncommittedRemoteBackupOrphan({
      backupId: input.backupId,
      captureAttemptToken: input.captureAttemptToken,
      backupTargetId: input.backupTargetId,
      objectKey: input.objectKey,
      backend: input.backend,
      cleanupTarget: input.cleanupTarget,
      commitError: input.commitError,
      cleanupError
    });
  } catch (recordError) {
    throw new AggregateError(
      [input.commitError, cleanupError, recordError],
      `Backup completion failed (${errorMessage(input.commitError)}), the uncommitted remote object could not be removed (${errorMessage(cleanupError)}), and its orphan locator could not be recorded (${errorMessage(recordError)})`
    );
  }
  throw new AggregateError(
    [input.commitError, cleanupError],
    `Backup completion failed (${errorMessage(input.commitError)}) and the uncommitted remote object could not be removed (${errorMessage(cleanupError)}); its orphan locator was recorded`
  );
}

async function recordCommittedBackupBookkeepingError(
  backupId: string,
  captureAttemptToken: string,
  status: "completed" | "partial",
  checksum: string,
  remoteObjectKey: string | null,
  field: "scheduleResultError" | "retentionCleanupError",
  bookkeepingError: unknown
) {
  const message = errorMessage(bookkeepingError);
  try {
    await query(
      `UPDATE backups
       SET metadata = metadata || $6::jsonb
       WHERE id = $1
         AND metadata->>'backupCaptureAttemptToken' = $2
         AND status = $3
         AND checksum = $4
         AND remote_object_key IS NOT DISTINCT FROM $5`,
      [
        backupId,
        captureAttemptToken,
        status,
        checksum,
        remoteObjectKey,
        JSON.stringify({ [field]: message })
      ]
    );
  } catch (recordError) {
    console.warn("Failed to record post-commit backup bookkeeping error", {
      backupId,
      field,
      bookkeepingError: message,
      recordError: errorMessage(recordError)
    });
  }
}

function retentionMetadata(backup: Backup) {
  const scheduleId = backup.metadata.scheduleId;
  const retentionCount = Number(backup.metadata.retentionCount);
  if (typeof scheduleId !== "string" || !scheduleId) return null;
  if (!Number.isInteger(retentionCount) || retentionCount < 1) return null;
  return { scheduleId, retentionCount };
}

export async function enforceScheduledBackupRetention(backup: Backup) {
  const metadata = retentionMetadata(backup);
  if (!metadata) return { deletedIds: [], failures: [] };

  const result = await query<{ id: string }>(
    `SELECT id
     FROM backups
     WHERE metadata->>'scheduleId' = $1
       AND status IN ('completed', 'partial')
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     OFFSET $2`,
    [metadata.scheduleId, metadata.retentionCount]
  );

  const deletedIds: string[] = [];
  const failures: string[] = [];
  for (const row of result.rows) {
    try {
      await deleteBackup(row.id);
      deletedIds.push(row.id);
    } catch (error) {
      failures.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    await query(
      `UPDATE backups
       SET metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [backup.id, JSON.stringify({ retentionCleanupFailures: failures })]
    );
  }

  return { deletedIds, failures };
}

async function beginBackupCaptureAttempt(
  backupId: string,
  executionFence?: JobExecutionFence
): Promise<BackupCaptureAttempt> {
  await mkdir(env.BACKUP_DIR, { recursive: true });
  const token = randomUUID();
  const directory = await trackBackupTemporaryDirectory(
    await mkdtemp(path.join(env.BACKUP_DIR, `.composebastion-capture-${token}-`))
  );
  const attempt = {
    token,
    directory,
    artifactPath: path.join(directory, "artifact")
  };
  try {
    const started = await executionQuery(
      executionFence,
      `UPDATE backups
       SET status = 'running',
           error = null,
           started_at = COALESCE(started_at, now()),
           metadata = metadata || $2::jsonb
       WHERE id = $1
         AND metadata->>'deletionClaimToken' IS NULL
       RETURNING id`,
      [
        backupId,
        JSON.stringify({
          backupCaptureAttemptToken: token,
          backupCaptureAttemptStartedAt: new Date().toISOString()
        })
      ]
    );
    if (started.rowCount === 0) {
      throw Object.assign(new Error("Backup is being deleted"), { statusCode: 409 });
    }
    return attempt;
  } catch (error) {
    await removeTrackedBackupTemporaryDirectory(directory).catch(() => undefined);
    throw error;
  }
}

async function publishBackupCaptureAttempt(input: {
  backup: Backup;
  attempt: BackupCaptureAttempt;
  status: "completed" | "partial";
  sizeBytes: number;
  checksum: string;
  remoteObjectKey: string | null;
  remoteWriteIntent: Omit<RemoteArtifactWriteIntent, "claimToken"> | null;
  error: string | null;
  metadata: Record<string, unknown>;
  retainLocalArtifact: boolean;
  executionFence?: JobExecutionFence;
}) {
  const commit = async (client: PoolClient) => {
    const selected = await client.query<{
      metadata: Record<string, unknown>;
    }>(
      "SELECT metadata FROM backups WHERE id = $1 FOR UPDATE",
      [input.backup.id]
    );
    const current = selected.rows[0];
    if (
      !current
      || current.metadata?.backupCaptureAttemptToken !== input.attempt.token
      || current.metadata?.deletionClaimToken
    ) {
      throw Object.assign(
        new Error(`Backup capture attempt no longer owns backup ${input.backup.id}`),
        { code: "BACKUP_CAPTURE_ATTEMPT_LOST" }
      );
    }

    if (input.retainLocalArtifact) {
      const canonicalPath = safeBackupPath(input.backup.fileName);
      await mkdir(path.dirname(canonicalPath), { recursive: true });
      // The row lock prevents a successor from changing the attempt token while
      // this exact attempt atomically publishes its completed local archive.
      // Keep the attempt-owned source until the database outcome is known so a
      // lost commit response cannot destroy the only reconcilable copy.
      const publishPath = `${input.attempt.artifactPath}.publish`;
      await copyFile(input.attempt.artifactPath, publishPath);
      await rename(publishPath, canonicalPath);
    }

    const committed = await client.query(
      `UPDATE backups
       SET status = $3,
           size_bytes = $4,
           checksum = $5,
           remote_object_key = $6,
           error = $7,
           completed_at = now(),
           metadata = metadata || $8::jsonb
       WHERE id = $1
         AND metadata->>'backupCaptureAttemptToken' = $2
         AND metadata->>'deletionClaimToken' IS NULL
       RETURNING id`,
      [
        input.backup.id,
        input.attempt.token,
        input.status,
        input.sizeBytes,
        input.checksum,
        input.remoteObjectKey,
        input.error,
        JSON.stringify({
          ...input.metadata,
          backupCaptureCommittedToken: input.attempt.token,
          backupCaptureAttemptCompletedAt: new Date().toISOString()
        })
      ]
    );
    if (committed.rowCount !== 1) {
      throw Object.assign(
        new Error(`Backup capture attempt no longer owns backup ${input.backup.id}`),
        { code: "BACKUP_CAPTURE_ATTEMPT_LOST" }
      );
    }
    if (
      input.remoteWriteIntent
      && !await clearRemoteArtifactWriteIntent(input.remoteWriteIntent, client)
    ) {
      throw new Error(
        "Backup remote locator could not atomically clear its write intent"
      );
    }
  };
  if (input.executionFence) {
    await input.executionFence.withActiveLease(commit);
  } else {
    await withTransaction(commit);
  }
}

async function reconcileBackupCaptureCommit(input: {
  backup: Backup;
  attempt: BackupCaptureAttempt;
  status: "completed" | "partial";
  sizeBytes: number;
  checksum: string;
  remoteObjectKey: string | null;
  remoteBackend: "s3" | "rclone" | null;
  commitError: unknown;
}) {
  let current;
  try {
    const result = await query<{
      status: string;
      size_bytes: string | number | null;
      checksum: string | null;
      remote_object_key: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT status, size_bytes, checksum, remote_object_key, metadata
       FROM backups
       WHERE id = $1`,
      [input.backup.id]
    );
    current = result.rows[0] ?? null;
  } catch (readError) {
    const reconciliationMessage = [
      "Backup capture commit outcome is unknown; attempt-owned local and remote artifacts were preserved for reconciliation.",
      `Commit error: ${errorMessage(input.commitError)}.`,
      `Status read error: ${errorMessage(readError)}.`
    ].join(" ");
    let preservationError: unknown = null;
    try {
      await preserveBackupCaptureAttempt(input.attempt, {
        reason: "capture_commit_outcome_unknown",
        backupId: input.backup.id,
        sizeBytes: input.sizeBytes,
        checksum: input.checksum,
        remoteObjectKey: input.remoteObjectKey,
        backupTargetId: input.backup.backupTargetId,
        remoteBackend: input.remoteBackend
      });
    } catch (error) {
      preservationError = error;
    }
    await query(
      `UPDATE backups
       SET metadata = metadata || $3::jsonb
       WHERE id = $1
         AND metadata->>'backupCaptureAttemptToken' = $2`,
      [
        input.backup.id,
        input.attempt.token,
        JSON.stringify({
          backupCaptureCommitReconciliationRequired: true,
          backupCaptureCommitReconciliationError: reconciliationMessage,
          pendingAttemptRemoteObjectKey: input.remoteObjectKey,
          pendingAttemptLocalPath: input.attempt.artifactPath,
          pendingAttemptSizeBytes: input.sizeBytes,
          pendingAttemptChecksum: input.checksum
        })
      ]
    ).catch(() => undefined);
    throw Object.assign(
      new AggregateError(
        [
          input.commitError,
          readError,
          ...(preservationError ? [preservationError] : [])
        ],
        reconciliationMessage
      ),
      {
        code: "BACKUP_CAPTURE_RECONCILIATION_REQUIRED" as const,
        backupCaptureEvidence: {
          reason: "capture_commit_outcome_unknown",
          sizeBytes: input.sizeBytes,
          checksum: input.checksum,
          remoteObjectKey: input.remoteObjectKey,
          backupTargetId: input.backup.backupTargetId,
          remoteBackend: input.remoteBackend
        }
      }
    );
  }

  const committed = Boolean(
    current
    && current.metadata?.backupCaptureCommittedToken === input.attempt.token
    && Number(current.size_bytes) === input.sizeBytes
    && current.checksum === input.checksum
    && current.remote_object_key === input.remoteObjectKey
  );
  return committed ? "committed" as const : "not_committed" as const;
}

async function completeBackupAfterCapture(
  backup: Backup,
  attempt: BackupCaptureAttempt,
  sizeBytes: number,
  metadata: Record<string, unknown> = {},
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const localPath = attempt.artifactPath;
  const checksum = await hashFile(localPath);
  const finalMetadata: Record<string, unknown> = { ...metadata };
  let remoteObjectKey: string | null = null;
  let remoteObjectPendingCommit: {
    key: string;
    backend: "s3" | "rclone";
    cleanupTarget: WorkerBackupTarget;
  } | null = null;
  let verifiedRemoteWriteIntent:
    Omit<RemoteArtifactWriteIntent, "claimToken"> | null = null;
  let removeLocalAfterCommit = false;
  let status: "completed" | "partial" = "completed";
  let error: string | null = null;

  if (backup.backupTargetId) {
    try {
      await executionCheckpoint(executionFence);
      const upload = await uploadBackupArtifactToRemote(
        backup,
        localPath,
        checksum,
        attempt.token
      );
      if (upload) {
        remoteObjectKey = upload.remoteObjectKey;
        remoteObjectPendingCommit = {
          key: upload.remoteObjectKey,
          backend: upload.remoteBackend,
          cleanupTarget: upload.cleanupTarget
        };
        verifiedRemoteWriteIntent = {
          ownerKind: "backup",
          ownerId: backup.id,
          backupTargetId: backup.backupTargetId!,
          objectKey: upload.remoteObjectKey,
          backend: upload.remoteBackend,
          attemptToken: attempt.token
        };
        finalMetadata.remoteBackend = upload.remoteBackend;
        finalMetadata.remoteSizeBytes = upload.remoteSizeBytes;
        finalMetadata.remoteEtag = upload.remoteEtag;
        finalMetadata.remoteChecksum = upload.remoteChecksum;
        finalMetadata.remoteDeclaredChecksum = upload.remoteDeclaredChecksum;
        finalMetadata.remoteVerifiedAt = upload.remoteVerifiedAt;
        finalMetadata.localCachePolicy = upload.localCachePolicy;
        if (upload.localCachePolicy === "remote_only") {
          removeLocalAfterCommit = true;
        }
      }
    } catch (uploadError) {
      status = "partial";
      if (uploadError instanceof BackupRemoteVerificationError) {
        error = uploadError.message;
        if (uploadError.phase === "upload") {
          finalMetadata.remoteUploadError = uploadError.verificationError;
          finalMetadata.remoteObjectDeletedAfterAmbiguousUpload = uploadError.remoteObjectDeleted;
        } else {
          finalMetadata.remoteVerificationError = uploadError.verificationError;
        }
        finalMetadata.remoteVerified = false;
        if (uploadError.orphanRemoteObject) {
          if (!backup.backupTargetId) {
            throw new Error("Remote backup orphan has no backup target");
          }
          await recordRemoteArtifactOrphan({
            ownerKind: "backup",
            ownerId: backup.id,
            backupTargetId: backup.backupTargetId,
            objectKey: uploadError.orphanRemoteObject.key,
            backend: uploadError.orphanRemoteObject.backend,
            attemptToken: attempt.token,
            target: uploadError.cleanupTarget,
            cleanupError: uploadError.orphanRemoteObject.cleanupError
          });
          remoteObjectPendingCommit = {
            key: uploadError.orphanRemoteObject.key,
            backend: uploadError.orphanRemoteObject.backend,
            cleanupTarget: uploadError.cleanupTarget
          };
          const existingOrphanKeys = Array.isArray(backup.metadata.orphanRemoteObjectKeys)
            ? backup.metadata.orphanRemoteObjectKeys.filter(
              (key): key is string => typeof key === "string" && key.length > 0
            )
            : [];
          finalMetadata.orphanRemoteObjectKey = uploadError.orphanRemoteObject.key;
          finalMetadata.orphanRemoteObjectKeys = [
            ...new Set([...existingOrphanKeys, uploadError.orphanRemoteObject.key])
          ];
          finalMetadata.orphanRemoteBackend = uploadError.orphanRemoteObject.backend;
          finalMetadata.orphanBackupTargetId = backup.backupTargetId;
          finalMetadata.orphanCleanupError = safeDiagnosticMessage(
            uploadError.orphanRemoteObject.cleanupError
          );
        }
      } else {
        error = `Remote upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`;
        finalMetadata.remoteUploadError = error;
      }
    }
  }

  try {
    await publishBackupCaptureAttempt({
      backup,
      attempt,
      status,
      sizeBytes,
      checksum,
      remoteObjectKey,
      remoteWriteIntent: verifiedRemoteWriteIntent,
      error,
      metadata: finalMetadata,
      retainLocalArtifact: !removeLocalAfterCommit,
      executionFence
    });
  } catch (commitError) {
    const outcome = await reconcileBackupCaptureCommit({
      backup,
      attempt,
      status,
      sizeBytes,
      checksum,
      remoteObjectKey,
      remoteBackend: remoteObjectPendingCommit?.backend ?? null,
      commitError
    });
    if (outcome === "not_committed") {
      let preservationError: unknown = null;
      try {
        await preserveBackupCaptureAttempt(attempt, {
          reason: "capture_commit_not_committed",
          backupId: backup.id,
          sizeBytes,
          checksum,
          remoteObjectKey,
          backupTargetId: backup.backupTargetId,
          remoteBackend: remoteObjectPendingCommit?.backend ?? null
        });
      } catch (error) {
        preservationError = error;
      }
      let failure: unknown = commitError;
      if (remoteObjectPendingCommit && backup.backupTargetId) {
        try {
          await compensateUncommittedRemoteBackup({
            backupId: backup.id,
            captureAttemptToken: attempt.token,
            backupTargetId: backup.backupTargetId,
            objectKey: remoteObjectPendingCommit.key,
            backend: remoteObjectPendingCommit.backend,
            cleanupTarget: remoteObjectPendingCommit.cleanupTarget,
            commitError
          });
        } catch (compensationError) {
          failure = compensationError;
        }
      }
      if (preservationError) {
        failure = new AggregateError(
          [failure, preservationError],
          `${errorMessage(failure)}; the attempt-owned local artifact could not be marked for durable preservation (${errorMessage(preservationError)})`
        );
      }
      const thrown = failure instanceof Error ? failure : new Error(String(failure));
      throw Object.assign(thrown, {
        backupCaptureAttemptPreserved: true,
        backupCaptureEvidence: {
          reason: "capture_commit_not_committed" as const,
          sizeBytes,
          checksum,
          remoteObjectKey,
          backupTargetId: backup.backupTargetId,
          remoteBackend: remoteObjectPendingCommit?.backend ?? null
        }
      });
    }
  }

  // A remote-only backup must retain its sole local artifact until the remote
  // locator and integrity metadata have committed through the active job lease.
  // Cleanup is intentionally best-effort after that durability boundary: a
  // retained local copy is harmless, while downgrading the committed backup or
  // deleting before the update succeeds would make recovery ambiguous.
  // Everything below this point is post-commit bookkeeping. Build the
  // completed value from the row and values already committed so a transient
  // follow-up read cannot make the capture handler downgrade this backup.
  const completed: Backup = {
    ...backup,
    status,
    sizeBytes,
    checksum,
    remoteObjectKey,
    error,
    completedAt: new Date().toISOString(),
    metadata: { ...backup.metadata, ...finalMetadata }
  };
  const scheduleId = completed.metadata.scheduleId;
  if (typeof scheduleId === "string" && scheduleId) {
    try {
      await recordBackupScheduleResult(scheduleId, status, error);
    } catch (scheduleError) {
      await recordCommittedBackupBookkeepingError(
        backup.id,
        attempt.token,
        status,
        checksum,
        remoteObjectKey,
        "scheduleResultError",
        scheduleError
      );
    }
  }
  try {
    await enforceScheduledBackupRetention(completed);
  } catch (retentionError) {
    await recordCommittedBackupBookkeepingError(
      backup.id,
      attempt.token,
      status,
      checksum,
      remoteObjectKey,
      "retentionCleanupError",
      retentionError
    );
  }

  return { fileName: completed.fileName, sizeBytes, checksum, remoteObjectKey, status };
}

export async function runVolumeBackup(hostId: string, backupId: string, volumeName: string, executionFence?: JobExecutionFence) {
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "volume") throw new Error("Backup record is not a volume backup");
  const attempt = await beginBackupCaptureAttempt(backupId, executionFence);
  let operationError: unknown = null;

  try {
    const host = await getHostForWorker(hostId);
    await executionCheckpoint(executionFence);
    if (isDemoHost(host.public)) {
      const content = `ComposeBastion demo backup for ${volumeName}\nCreated: ${new Date().toISOString()}\n`;
      const sizeBytes = await writeBackupBytes(
        attempt.artifactPath,
        content,
        normalizeBackupEncryption(backup.encryption)
      );
      return {
        ...(await completeBackupAfterCapture(
          backup,
          attempt,
          sizeBytes,
          { demo: true, volumeName },
          executionFence
        )),
        demo: true
      };
    }
    if (host.connectionMode !== "ssh") {
      throw new Error("Volume backup currently requires SSH host mode.");
    }
    const command = withDockerEnv(
      `docker run --rm -v ${shQuote(`${volumeName}:/volume:ro`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar czf - .")}`,
      host.public.dockerSocketPath
    );
    const encryptedResult = await streamSshCommandToFile(
      host.ssh,
      command,
      attempt.artifactPath,
      10 * 60_000,
      createBackupEncryptTransform(normalizeBackupEncryption(backup.encryption))
    );
    return completeBackupAfterCapture(
      backup,
      attempt,
      encryptedResult.sizeBytes,
      { stderr: encryptedResult.stderr },
      executionFence
    );
  } catch (error) {
    operationError = error;
    const message = error instanceof Error ? error.message : String(error);
    const reconciliationRequired = (
      error instanceof Error
      && (error as { code?: unknown }).code === "BACKUP_CAPTURE_RECONCILIATION_REQUIRED"
    );
    const failureSql = `UPDATE backups
      SET status = 'failed', error = $3, completed_at = now()
      WHERE id = $1
        AND metadata->>'backupCaptureAttemptToken' = $2
      RETURNING id`;
    let failed = { rowCount: 0 as number | null };
    if (!reconciliationRequired) {
      try {
        failed = await executionQuery(
          executionFence,
          failureSql,
          [backupId, attempt.token, message]
        );
      } catch {
        failed = await query(failureSql, [backupId, attempt.token, message])
          .catch(() => ({ rowCount: 0 }));
      }
    }
    if (failed.rowCount === 1) {
      const scheduleId = backup.metadata.scheduleId;
      if (typeof scheduleId === "string" && scheduleId) {
        await recordBackupScheduleResult(scheduleId, "failed", message);
      }
    }
    throw error;
  } finally {
    try {
      if (
        operationError instanceof Error
        && (
          (operationError as { code?: unknown }).code === "BACKUP_CAPTURE_RECONCILIATION_REQUIRED"
          || (operationError as { backupCaptureAttemptPreserved?: unknown })
            .backupCaptureAttemptPreserved === true
        )
      ) {
        // The reconciliation helper writes a fail-closed marker. Repeat the
        // operation idempotently so even an error raised at a nearby boundary
        // cannot make this finally block erase the attempt-owned artifact.
        const evidence = (operationError as {
          backupCaptureEvidence?: {
            reason?: unknown;
            sizeBytes?: unknown;
            checksum?: unknown;
            remoteObjectKey?: unknown;
            backupTargetId?: unknown;
            remoteBackend?: unknown;
          };
        }).backupCaptureEvidence;
        const artifactStat = await stat(attempt.artifactPath);
        await preserveBackupCaptureAttempt(attempt, {
          reason: evidence?.reason === "capture_commit_not_committed"
            ? "capture_commit_not_committed"
            : "capture_commit_outcome_unknown",
          backupId,
          sizeBytes: typeof evidence?.sizeBytes === "number"
            ? evidence.sizeBytes
            : artifactStat.size,
          checksum: typeof evidence?.checksum === "string"
            ? evidence.checksum
            : await hashFile(attempt.artifactPath),
          remoteObjectKey: typeof evidence?.remoteObjectKey === "string"
            ? evidence.remoteObjectKey
            : null,
          backupTargetId: typeof evidence?.backupTargetId === "string"
            ? evidence.backupTargetId
            : backup.backupTargetId,
          remoteBackend: evidence?.remoteBackend === "s3"
            || evidence?.remoteBackend === "rclone"
            ? evidence.remoteBackend
            : null
        });
      } else {
        await removeTrackedBackupTemporaryDirectory(attempt.directory);
      }
    } catch (cleanupError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, cleanupError],
          `Backup capture failed (${errorMessage(operationError)}) and its attempt directory could not be removed (${errorMessage(cleanupError)})`
        );
      }
      await query(
        `UPDATE backups
         SET metadata = metadata || $3::jsonb
         WHERE id = $1
           AND metadata->>'backupCaptureAttemptToken' = $2`,
        [
          backupId,
          attempt.token,
          JSON.stringify({ backupCaptureAttemptCleanupError: errorMessage(cleanupError) })
        ]
      ).catch(() => undefined);
    }
  }
}

export async function runHostPathBackup(hostId: string, backupId: string, sourcePath: string, executionFence?: JobExecutionFence) {
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "host_path") throw new Error("Backup record is not a host-path backup");
  const normalizedSourcePath = normalizeHostSourcePath(sourcePath || backup.sourcePath || "");
  const attempt = await beginBackupCaptureAttempt(backupId, executionFence);
  let operationError: unknown = null;

  try {
    const host = await getHostForWorker(hostId);
    await executionCheckpoint(executionFence);
    if (isDemoHost(host.public)) {
      const content = `ComposeBastion demo host-path backup for ${normalizedSourcePath}\nCreated: ${new Date().toISOString()}\n`;
      const sizeBytes = await writeBackupBytes(
        attempt.artifactPath,
        content,
        normalizeBackupEncryption(backup.encryption)
      );
      return {
        ...(await completeBackupAfterCapture(
          backup,
          attempt,
          sizeBytes,
          { demo: true, sourcePath: normalizedSourcePath },
          executionFence
        )),
        demo: true
      };
    }
    if (host.connectionMode !== "ssh") {
      throw new Error("Host-path backup currently requires SSH host mode.");
    }
    const command = buildHostPathCaptureCommand(normalizedSourcePath);
    const result = await streamSshCommandToFile(
      host.ssh,
      command,
      attempt.artifactPath,
      10 * 60_000,
      createBackupEncryptTransform(normalizeBackupEncryption(backup.encryption))
    );
    return completeBackupAfterCapture(backup, attempt, result.sizeBytes, {
      stderr: result.stderr,
      sourcePath: normalizedSourcePath
    }, executionFence);
  } catch (error) {
    operationError = error;
    const message = error instanceof Error ? error.message : String(error);
    const reconciliationRequired = (
      error instanceof Error
      && (error as { code?: unknown }).code === "BACKUP_CAPTURE_RECONCILIATION_REQUIRED"
    );
    const failureSql = `UPDATE backups
      SET status = 'failed', error = $3, completed_at = now()
      WHERE id = $1
        AND metadata->>'backupCaptureAttemptToken' = $2
      RETURNING id`;
    let failed = { rowCount: 0 as number | null };
    if (!reconciliationRequired) {
      try {
        failed = await executionQuery(
          executionFence,
          failureSql,
          [backupId, attempt.token, message]
        );
      } catch {
        failed = await query(failureSql, [backupId, attempt.token, message])
          .catch(() => ({ rowCount: 0 }));
      }
    }
    if (failed.rowCount === 1) {
      const scheduleId = backup.metadata.scheduleId;
      if (typeof scheduleId === "string" && scheduleId) {
        await recordBackupScheduleResult(scheduleId, "failed", message);
      }
    }
    throw error;
  } finally {
    try {
      if (
        operationError instanceof Error
        && (
          (operationError as { code?: unknown }).code === "BACKUP_CAPTURE_RECONCILIATION_REQUIRED"
          || (operationError as { backupCaptureAttemptPreserved?: unknown })
            .backupCaptureAttemptPreserved === true
        )
      ) {
        const evidence = (operationError as {
          backupCaptureEvidence?: {
            reason?: unknown;
            sizeBytes?: unknown;
            checksum?: unknown;
            remoteObjectKey?: unknown;
            backupTargetId?: unknown;
            remoteBackend?: unknown;
          };
        }).backupCaptureEvidence;
        const artifactStat = await stat(attempt.artifactPath);
        await preserveBackupCaptureAttempt(attempt, {
          reason: evidence?.reason === "capture_commit_not_committed"
            ? "capture_commit_not_committed"
            : "capture_commit_outcome_unknown",
          backupId,
          sizeBytes: typeof evidence?.sizeBytes === "number"
            ? evidence.sizeBytes
            : artifactStat.size,
          checksum: typeof evidence?.checksum === "string"
            ? evidence.checksum
            : await hashFile(attempt.artifactPath),
          remoteObjectKey: typeof evidence?.remoteObjectKey === "string"
            ? evidence.remoteObjectKey
            : null,
          backupTargetId: typeof evidence?.backupTargetId === "string"
            ? evidence.backupTargetId
            : backup.backupTargetId,
          remoteBackend: evidence?.remoteBackend === "s3"
            || evidence?.remoteBackend === "rclone"
            ? evidence.remoteBackend
            : null
        });
      } else {
        await removeTrackedBackupTemporaryDirectory(attempt.directory);
      }
    } catch (cleanupError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, cleanupError],
          `Backup capture failed (${errorMessage(operationError)}) and its attempt directory could not be removed (${errorMessage(cleanupError)})`
        );
      }
      await query(
        `UPDATE backups
         SET metadata = metadata || $3::jsonb
         WHERE id = $1
           AND metadata->>'backupCaptureAttemptToken' = $2`,
        [
          backupId,
          attempt.token,
          JSON.stringify({ backupCaptureAttemptCleanupError: errorMessage(cleanupError) })
        ]
      ).catch(() => undefined);
    }
  }
}

async function demoVolumeExists(hostId: string, volumeName: string) {
  const result = await query(
    "SELECT 1 FROM resource_snapshots WHERE host_id = $1 AND kind = 'volume' AND external_id = $2",
    [hostId, volumeName]
  );
  return Boolean(result.rows[0]);
}

async function assertSshVolumeCanBeRestored(
  ssh: Parameters<typeof runSshCommand>[0],
  dockerSocketPath: string,
  targetVolumeName: string,
  overwrite: boolean
) {
  const inspect = await runSshCommand(
    ssh,
    withDockerEnv(`docker volume inspect ${shQuote(targetVolumeName)}`, dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (inspect.code === 0 && !overwrite) {
    throw new Error(
      `Volume ${targetVolumeName} already exists. Restore requires a new target so rollback can remove only attempt-owned data.`
    );
  }
}

type LegacyRestoreResource = {
  kind: "volume" | "directory";
  name: string;
};

type LegacyRestoreAttempt = {
  token: string;
  scope: string;
  resource: LegacyRestoreResource;
  executionFence?: JobExecutionFence;
  durable: boolean;
};

class LegacyRestoreRemoteOutcomeUnknownError
  extends Error {
  constructor(cause: unknown) {
    super(
      "A backup restore remote mutation may still be running; exact-resource cleanup is deferred until bounded quiescence.",
      { cause }
    );
    this.name =
      "LegacyRestoreRemoteOutcomeUnknownError";
  }
}

function legacyRestoreOwnership(
  attempt: LegacyRestoreAttempt
) {
  return `${attempt.token}|${attempt.scope}`;
}

async function beginLegacyRestoreAttempt(input: {
  backupId: string;
  targetHostId: string;
  operationJobId?: string;
  resource: LegacyRestoreResource;
  retainOnSuccess: boolean;
  allowedPathRoots?: string[];
  executionFence?: JobExecutionFence;
}) {
  const attempt: LegacyRestoreAttempt = {
    token: randomUUID(),
    scope: `backup:${input.backupId}`,
    resource: input.resource,
    executionFence: input.executionFence,
    durable: Boolean(input.operationJobId)
  };
  if (!attempt.durable) return attempt;
  await beginRecoveryRestoreAttempt({
    attemptToken: attempt.token,
    backupId: input.backupId,
    targetHostId: input.targetHostId,
    restoreScope: attempt.scope,
    operationJobId: input.operationJobId,
    allowedPathRoots: input.allowedPathRoots,
    retainOnSuccess: input.retainOnSuccess
  }, input.executionFence);
  await registerRecoveryRestoreResource(
    attempt.token,
    input.resource.kind,
    input.resource.name,
    input.executionFence
  );
  return attempt;
}

async function runLegacyRestoreMutation<T>(
  attempt: LegacyRestoreAttempt,
  mutation: () => Promise<T>
) {
  try {
    return await mutation();
  } catch (error) {
    if (attempt.durable) {
      let ledgerError: unknown;
      try {
        await markRecoveryRestoreAttemptCleanupPending(
          attempt.token,
          error,
          { remoteOutcomeUnknown: true }
        );
      } catch (markError) {
        ledgerError = markError;
      }
      throw new LegacyRestoreRemoteOutcomeUnknownError(
        ledgerError
          ? new AggregateError(
              [error, ledgerError],
              "Remote mutation and durable cleanup-intent update both failed"
            )
          : error
      );
    }
    throw error;
  }
}

async function acquireLegacyRestoreDirectory(
  ssh: Parameters<typeof runSshCommand>[0],
  targetPath: string,
  attempt: LegacyRestoreAttempt
) {
  const normalized = normalizeHostTargetPath(targetPath);
  const command = buildAcquireOwnedRemoteDirectoryCommand({
    targetPath: normalized,
    ownerValue: legacyRestoreOwnership(attempt),
    attemptToken: attempt.token,
    label: `backup restore path ${normalized}`
  });
  const result = await runLegacyRestoreMutation(
    attempt,
    () => runSshCommand(
      ssh,
      command,
      { timeoutMs: 60_000 }
    )
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr
      || result.stdout
      || `Failed to acquire restore path ${normalized}`
    );
  }
}

async function cleanupLegacyRestoreVolume(
  ssh: Parameters<typeof runSshCommand>[0],
  dockerSocketPath: string,
  volumeName: string,
  attempt: LegacyRestoreAttempt
) {
  const ownershipFormat =
    `{{.Name}}|{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`;
  const inspect = withDockerEnv(
    `docker volume inspect --format ${shQuote(ownershipFormat)} ${shQuote(volumeName)}`,
    dockerSocketPath
  );
  const expected = legacyRestoreOwnership(attempt);
  const command = [
    `restore_identity="$(${inspect} 2>/dev/null)" || { ${withDockerEnv(
      `docker volume inspect ${shQuote(volumeName)}`,
      dockerSocketPath
    )} >/dev/null 2>&1 || exit 0; exit 72; }`,
    `restore_id="\${restore_identity%%|*}"`,
    `restore_owner="\${restore_identity#*|}"`,
    [
      `if [ -z "$restore_id" ] || [ "$restore_owner" != ${shQuote(expected)} ]`,
      "then exit 73",
      "fi"
    ].join("; "),
    `restore_boundary="$(${withDockerEnv(
      `docker volume inspect --format ${shQuote(ownershipFormat)} "$restore_id"`,
      dockerSocketPath
    )} 2>/dev/null)" || { ${withDockerEnv(
      `docker volume inspect "$restore_id"`,
      dockerSocketPath
    )} >/dev/null 2>&1 || exit 0; exit 72; }`,
    `if [ "$restore_boundary" != "$restore_identity" ]; then exit 73; fi`,
    withDockerEnv(
      `docker volume rm --force "$restore_id"`,
      dockerSocketPath
    )
  ].join("; ");
  const result = await runSshCommand(
    ssh,
    command,
    { timeoutMs: 60_000 }
  );
  if (result.code === 0) return;
  if (result.code === 73) {
    throw new Error(
      `Volume ${volumeName} ownership changed; refusing cleanup`
    );
  }
  throw new Error(
    result.stderr
    || result.stdout
    || `Failed to clean restore volume ${volumeName}`
  );
}

async function cleanupLegacyRestoreDirectory(
  ssh: Parameters<typeof runSshCommand>[0],
  targetPath: string,
  attempt: LegacyRestoreAttempt
) {
  const normalized = normalizeHostTargetPath(targetPath);
  const command = buildCleanupOwnedRemoteDirectoryCommand({
    targetPath: normalized,
    ownerValue: legacyRestoreOwnership(attempt),
    attemptToken: attempt.token,
    label: `backup restore path ${normalized}`
  });
  const result = await runSshCommand(
    ssh,
    command,
    { timeoutMs: 60_000 }
  );
  if (result.code === 0) return;
  if (isOwnedRemoteDirectorySafetyRefusal(result.code)) {
    throw new Error(
      `Restore path ${normalized} ownership changed; refusing cleanup`
    );
  }
  throw new Error(
    result.stderr
    || result.stdout
    || `Failed to clean restore path ${normalized}`
  );
}

async function markLegacyRestoreSucceeded(
  attempt: LegacyRestoreAttempt
) {
  if (!attempt.durable) return;
  await markRecoveryRestoreResourceObserved(
    attempt.token,
    attempt.resource.kind,
    attempt.resource.name,
    attempt.executionFence
  );
  await markRecoveryRestoreAttemptAwaitingDisposition(
    attempt.token,
    attempt.executionFence
  );
}

async function cleanupLegacyRestoreAttempt(
  attempt: LegacyRestoreAttempt,
  cleanup: () => Promise<void>
) {
  try {
    await cleanup();
  } catch (error) {
    if (attempt.durable) {
      try {
        await markRecoveryRestoreAttemptCleanupPending(
          attempt.token,
          error,
          { remoteOutcomeUnknown: true }
        );
      } catch (ledgerError) {
        throw new AggregateError(
          [error, ledgerError],
          "Restore cleanup outcome and durable quiescence update both failed"
        );
      }
    }
    throw error;
  }
  if (attempt.durable) {
    await markRecoveryRestoreAttemptCleaned(
      attempt.token,
      attempt.executionFence
    );
  }
}

async function handleLegacyRestoreFailure(
  attempt: LegacyRestoreAttempt,
  error: unknown,
  cleanup: () => Promise<void>
) {
  if (
    error instanceof
      LegacyRestoreRemoteOutcomeUnknownError
  ) {
    return;
  }
  if (attempt.durable) {
    await markRecoveryRestoreAttemptCleanupPending(
      attempt.token,
      error
    ).catch(() => undefined);
  }
  try {
    await cleanupLegacyRestoreAttempt(
      attempt,
      cleanup
    );
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `Backup restore failed and exact-resource cleanup could not complete: ${errorMessage(cleanupError)}`
    );
  }
}

async function restoreVolumeBackupArtifact(
  hostId: string,
  backup: Backup,
  targetVolumeName: string,
  executionFence?: JobExecutionFence,
  operationJobId?: string,
  retainOnSuccess = true
) {
  let cleanup: () => Promise<void> =
    async () => undefined;
  const result = await withBackupLocalArtifact(
    backup,
    async (localPath) => {
      const host = await getHostForWorker(hostId);
      await executionCheckpoint(executionFence);
      if (isDemoHost(host.public)) {
        if (
          await demoVolumeExists(
            hostId,
            targetVolumeName
          )
        ) {
          throw new Error(
            `Volume ${targetVolumeName} already exists. Restore requires a new target so rollback can remove only attempt-owned data.`
          );
        }
        await executionQuery(
          executionFence,
          `INSERT INTO resource_snapshots (id, host_id, kind, external_id, name, data, updated_at)
           VALUES ($1, $2, 'volume', $3, $3, $4, now())
           ON CONFLICT (host_id, kind, external_id)
           DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [
            uuid(),
            hostId,
            targetVolumeName,
            {
              Name: targetVolumeName,
              Driver: "local",
              Mountpoint:
                `/var/lib/docker/volumes/${targetVolumeName}/_data`,
              Scope: "local",
              Labels: {
                "composebastion.demo.restore":
                  backup.id
              }
            }
          ]
        );
        return {
          stdout:
            `Demo restore completed into ${targetVolumeName}`,
          stderr: "",
          demo: true
        };
      }
      if (host.connectionMode !== "ssh") {
        throw new Error(
          "Volume restore currently requires SSH host mode."
        );
      }
      await assertSshVolumeCanBeRestored(
        host.ssh,
        host.public.dockerSocketPath,
        targetVolumeName,
        false
      );
      const attempt =
        await beginLegacyRestoreAttempt({
          backupId: backup.id,
          targetHostId: hostId,
          operationJobId,
          resource: {
            kind: "volume",
            name: targetVolumeName
          },
          retainOnSuccess,
          executionFence
        });
      cleanup = () => cleanupLegacyRestoreAttempt(
        attempt,
        () => cleanupLegacyRestoreVolume(
          host.ssh,
          host.public.dockerSocketPath,
          targetVolumeName,
          attempt
        )
      );
      try {
        await executionCheckpoint(executionFence);
        const createCommand = withDockerEnv(
          [
            "docker volume create",
            `--label ${shQuote(
              `${RESTORE_ATTEMPT_LABEL}=${attempt.token}`
            )}`,
            `--label ${shQuote(
              `${RESTORE_SCOPE_LABEL}=${attempt.scope}`
            )}`,
            shQuote(targetVolumeName)
          ].join(" "),
          host.public.dockerSocketPath
        );
        const createResult =
          await runLegacyRestoreMutation(
            attempt,
            () => runSshCommand(
              host.ssh,
              createCommand,
              { timeoutMs: 60_000 }
            )
          );
        if (createResult.code !== 0) {
          throw new Error(
            createResult.stderr
            || createResult.stdout
            || `Failed to create volume ${targetVolumeName}`
          );
        }
        await executionCheckpoint(executionFence);
        const ownershipFormat =
          `{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`;
        const ownership = await runSshCommand(
          host.ssh,
          withDockerEnv(
            `docker volume inspect --format ${shQuote(ownershipFormat)} ${shQuote(targetVolumeName)}`,
            host.public.dockerSocketPath
          ),
          { timeoutMs: 60_000 }
        );
        if (
          ownership.code !== 0
          || ownership.stdout.trim()
            !== legacyRestoreOwnership(attempt)
        ) {
          throw new Error(
            `Volume ${targetVolumeName} ownership could not be verified after creation`
          );
        }
        const restoreCommand = withDockerEnv(
          `docker run --rm -i -v ${shQuote(`${targetVolumeName}:/volume`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar xzf -")}`,
          host.public.dockerSocketPath
        );
        const restored =
          await runLegacyRestoreMutation(
            attempt,
            () => pipeReadableToSshCommand(
              host.ssh,
              createStoredBackupReadStream(
                backup,
                localPath
              ),
              restoreCommand
            )
          );
        await executionCheckpoint(executionFence);
        if (restored.code !== 0) {
          throw new Error(
            restored.stderr
            || restored.stdout
            || "Restore failed"
          );
        }
        await markLegacyRestoreSucceeded(attempt);
        return {
          stdout: restored.stdout,
          stderr: restored.stderr
        };
      } catch (error) {
        await handleLegacyRestoreFailure(
          attempt,
          error,
          () => cleanupLegacyRestoreVolume(
            host.ssh,
            host.public.dockerSocketPath,
            targetVolumeName,
            attempt
          )
        );
        throw error;
      }
    }
  );
  return { result, cleanup };
}

export async function runVolumeRestore(
  hostId: string,
  backupId: string,
  targetVolumeName: string,
  overwrite = false,
  executionFence?: JobExecutionFence,
  operationJobId?: string
) {
  if (overwrite) {
    throw new Error(
      "Overwrite restore is disabled because merging into an existing volume cannot be rolled back safely"
    );
  }
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "volume") throw new Error("Backup record is not a volume backup");
  return (
    await restoreVolumeBackupArtifact(
      hostId,
      backup,
      targetVolumeName,
      executionFence,
      operationJobId,
      true
    )
  ).result;
}

async function restoreHostPathBackupArtifact(
  hostId: string,
  backup: Backup,
  targetPath: string,
  executionFence?: JobExecutionFence,
  operationJobId?: string,
  retainOnSuccess = true
) {
  const normalizedTargetPath =
    normalizeHostTargetPath(targetPath);
  let cleanup: () => Promise<void> =
    async () => undefined;
  const result = await withBackupLocalArtifact(
    backup,
    async (localPath) => {
      const host = await getHostForWorker(hostId);
      await executionCheckpoint(executionFence);
      if (isDemoHost(host.public)) {
        return {
          stdout:
            `Demo host-path restore completed into ${normalizedTargetPath}`,
          stderr: "",
          demo: true
        };
      }
      if (host.connectionMode !== "ssh") {
        throw new Error(
          "Host-path restore currently requires SSH host mode."
        );
      }
      await assertHostPathCanBeRestored(
        host.ssh,
        normalizedTargetPath,
        false
      );
      const attempt =
        await beginLegacyRestoreAttempt({
          backupId: backup.id,
          targetHostId: hostId,
          operationJobId,
          resource: {
            kind: "directory",
            name: normalizedTargetPath
          },
          retainOnSuccess,
          allowedPathRoots: [
            normalizedTargetPath
          ],
          executionFence
        });
      cleanup = () => cleanupLegacyRestoreAttempt(
        attempt,
        () => cleanupLegacyRestoreDirectory(
          host.ssh,
          normalizedTargetPath,
          attempt
        )
      );
      try {
        await executionCheckpoint(executionFence);
        await acquireLegacyRestoreDirectory(
          host.ssh,
          normalizedTargetPath,
          attempt
        );
        await executionCheckpoint(executionFence);
        const restoreCommand =
          buildHostPathRestoreCommand(
            normalizedTargetPath
          );
        const restored =
          await runLegacyRestoreMutation(
            attempt,
            () => pipeReadableToSshCommand(
              host.ssh,
              createStoredBackupReadStream(
                backup,
                localPath
              ),
              restoreCommand
            )
          );
        await executionCheckpoint(executionFence);
        if (restored.code !== 0) {
          throw new Error(
            restored.stderr
            || restored.stdout
            || "Host-path restore failed"
          );
        }
        await markLegacyRestoreSucceeded(attempt);
        return {
          stdout: restored.stdout,
          stderr: restored.stderr,
          targetPath: normalizedTargetPath
        };
      } catch (error) {
        await handleLegacyRestoreFailure(
          attempt,
          error,
          () => cleanupLegacyRestoreDirectory(
            host.ssh,
            normalizedTargetPath,
            attempt
          )
        );
        throw error;
      }
    }
  );
  return { result, cleanup };
}

export async function runHostPathRestore(
  hostId: string,
  backupId: string,
  targetPath: string,
  overwrite = false,
  executionFence?: JobExecutionFence,
  operationJobId?: string
) {
  if (overwrite) {
    throw new Error(
      "Overwrite restore is disabled because merging into an existing host path cannot be rolled back safely"
    );
  }
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "host_path") throw new Error("Backup record is not a host-path backup");
  return (
    await restoreHostPathBackupArtifact(
      hostId,
      backup,
      targetPath,
      executionFence,
      operationJobId,
      true
    )
  ).result;
}

async function verifyBackupRemoteObject(backup: Backup, failures: string[]) {
  const objectKey = backupRemoteObjectKey(backup);
  if (!backup.backupTargetId) return;
  try {
    const target = await loadWorkerBackupTarget(backup.backupTargetId);
    if (target.kind === "local") return;
    if (target.kind !== "s3" && target.kind !== "rclone") {
      failures.push("remote target does not support verification");
      return;
    }
    if (!objectKey) {
      failures.push("remote locator missing");
      return;
    }
    await assertBackupTargetS3EndpointAllowed(target);
    const head = await headRemoteArtifact(target, objectKey);
    if (backup.sizeBytes != null && head.sizeBytes != null && backup.sizeBytes !== head.sizeBytes) {
      failures.push("remote size mismatch");
    }
    if (backup.checksum && head.checksum && backup.checksum !== head.checksum) {
      failures.push("remote checksum mismatch");
    }
    await downloadAndVerifyRemoteBackupArtifact({
      target,
      objectKey,
      expectedSizeBytes: backup.sizeBytes,
      expectedChecksum: backup.checksum,
      temporaryPrefix: ".composebastion-remote-verify-"
    });
  } catch (error) {
    failures.push(`remote verify failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function testBackupArchiveOnHost(hostId: string, backup: Backup, localPath: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return;
  if (host.connectionMode !== "ssh") throw new Error("Archive testing currently requires SSH host mode.");
  const result = await pipeReadableToSshCommand(host.ssh, createStoredBackupReadStream(backup, localPath), "tar tzf - >/dev/null");
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Archive test failed");
}

function parseDrillMetrics(stdout: string) {
  const [files, bytes] = stdout.trim().split(/\s+/);
  const fileCount = Number(files ?? 0);
  const totalBytes = Number(bytes ?? 0);
  return {
    fileCount: Number.isFinite(fileCount) ? fileCount : 0,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0
  };
}

function buildVolumeDrillMetricsCommand(volumeName: string, dockerSocketPath: string) {
  const script = "files=$(find /volume -type f | wc -l); bytes=$(find /volume -type f -exec wc -c {} \\; | awk '{sum += $1} END {print sum + 0}'); printf '%s %s\\n' \"$files\" \"$bytes\"";
  return withDockerEnv(
    `docker run --rm -v ${shQuote(`${volumeName}:/volume:ro`)} alpine:3.20 sh -c ${shQuote(script)}`,
    dockerSocketPath
  );
}

function buildHostPathDrillMetricsCommand(targetPath: string) {
  const normalized = assertAllowedBackupDrillPath(targetPath);
  const quoted = shQuote(normalized);
  return `files=$(find ${quoted} -type f | wc -l); bytes=$(find ${quoted} -type f -exec wc -c {} \\; | awk '{sum += $1} END {print sum + 0}'); printf '%s %s\\n' "$files" "$bytes"`;
}

async function recordBackupDrillResult(
  backupId: string,
  status: "completed" | "failed",
  details: Record<string, unknown>,
  executionFence?: JobExecutionFence
) {
  await executionQuery(
    executionFence,
    `UPDATE backups
     SET last_drill_at = now(),
         last_drill_status = $2,
         metadata = metadata || $3::jsonb
     WHERE id = $1`,
    [backupId, status, JSON.stringify({ lastDrill: details })]
  );
}

export async function runBackupDrill(
  hostId: string,
  backupId: string,
  executionFence?: JobExecutionFence,
  operationJobId?: string,
  requestedDrillId?: string
) {
  await executionCheckpoint(executionFence);
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  const drillId = requestedDrillId
    ?? randomUUID();
  const startedAt = new Date().toISOString();

  try {
    if (backup.status !== "completed" && backup.status !== "partial") {
      throw new Error("Only completed or partial backups can be drilled");
    }
    return await withBackupLocalArtifact(backup, async (localPath) => {
      const host = await getHostForWorker(hostId);
      if (isDemoHost(host.public)) {
        const result = { backupId, drillId, status: "completed" as const, demo: true };
        await recordBackupDrillResult(backupId, "completed", { ...result, startedAt, completedAt: new Date().toISOString() }, executionFence);
        return result;
      }
      if (host.connectionMode !== "ssh") {
        throw new Error("Backup drill currently requires SSH host mode.");
      }

      await executionCheckpoint(executionFence);
      await testBackupArchiveOnHost(hostId, backup, localPath);

      if (backup.kind === "volume") {
        const scratchVolume = buildBackupDrillVolumeName(backup.id, drillId);
        const restored =
          await restoreVolumeBackupArtifact(
            hostId,
            backup,
            scratchVolume,
            executionFence,
            operationJobId,
            false
          );
        let metrics;
        try {
          await executionCheckpoint(executionFence);
          const inspected = await runSshCommand(host.ssh, buildVolumeDrillMetricsCommand(scratchVolume, host.public.dockerSocketPath), { timeoutMs: 120_000 });
          if (inspected.code !== 0) throw new Error(inspected.stderr || inspected.stdout || "Failed to inspect drill volume");
          metrics = parseDrillMetrics(inspected.stdout);
        } catch (workError) {
          try {
            await restored.cleanup();
          } catch (cleanupError) {
            throw new AggregateError(
              [workError, cleanupError],
              "Backup drill validation and exact-resource cleanup both failed"
            );
          }
          throw workError;
        }
        await restored.cleanup();
        const result = {
          backupId,
          drillId,
          status: "completed" as const,
          scratchTarget: scratchVolume,
          ...metrics,
          cleanupError: null
        };
        await recordBackupDrillResult(backupId, "completed", { ...result, startedAt, completedAt: new Date().toISOString() }, executionFence);
        return result;
      }

      const scratchPath = buildBackupDrillPath(backup.id, drillId);
      const restored =
        await restoreHostPathBackupArtifact(
          hostId,
          backup,
          scratchPath,
          executionFence,
          operationJobId,
          false
        );
      let metrics;
      try {
        await executionCheckpoint(executionFence);
        const inspected = await runSshCommand(host.ssh, buildHostPathDrillMetricsCommand(scratchPath), { timeoutMs: 120_000 });
        if (inspected.code !== 0) throw new Error(inspected.stderr || inspected.stdout || "Failed to inspect host-path drill restore");
        metrics = parseDrillMetrics(inspected.stdout);
      } catch (workError) {
        try {
          await restored.cleanup();
        } catch (cleanupError) {
          throw new AggregateError(
            [workError, cleanupError],
            "Backup drill validation and exact-resource cleanup both failed"
          );
        }
        throw workError;
      }
      await restored.cleanup();
      const result = {
        backupId,
        drillId,
        status: "completed" as const,
        scratchTarget: scratchPath,
        ...metrics,
        cleanupError: null
      };
      await recordBackupDrillResult(backupId, "completed", { ...result, startedAt, completedAt: new Date().toISOString() }, executionFence);
      return result;
    });
  } catch (error) {
    const cleanupError = error instanceof Error && "cleanupError" in error
      ? (error as Error & { cleanupError?: string }).cleanupError ?? null
      : null;
    const details = {
      backupId,
      drillId,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: errorMessage(error),
      cleanupError
    };
    await recordBackupDrillResult(backupId, "failed", details, executionFence);
    throw error;
  }
}

export async function runBackupVerify(hostId: string, backupId: string, options: { testArchive?: boolean } = {}, executionFence?: JobExecutionFence) {
  await executionCheckpoint(executionFence);
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  const verifiedAt = new Date().toISOString();
  const failures: string[] = [];

  try {
    await withBackupLocalArtifact(backup, async (localPath) => {
      const checksum = await hashFile(localPath);
      if (backup.checksum && backup.checksum !== checksum) {
        failures.push("local checksum mismatch");
      }
      await verifyBackupRemoteObject(backup, failures);
      if (options.testArchive) {
        await testBackupArchiveOnHost(hostId, backup, localPath);
      }
    });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const verifyStatus = failures.length ? "failed" : "completed";
  const previousVerifyStatus = typeof backup.metadata.verifyStatus === "string" ? backup.metadata.verifyStatus : null;
  await executionQuery(
    executionFence,
    `UPDATE backups
     SET verified_at = CASE WHEN $2 = 'completed' THEN now() ELSE verified_at END,
         metadata = metadata || $3::jsonb
     WHERE id = $1`,
    [backupId, verifyStatus, JSON.stringify({ verifiedAt, verifyStatus, verifyFailures: failures })]
  );
  if (failures.length) {
    const message = `Backup ${backupLabel(backup)} verification failed: ${failures.join("; ")}`;
    const scheduleId = backup.metadata.scheduleId;
    if (typeof scheduleId === "string" && scheduleId && previousVerifyStatus !== "failed") {
      await notifyBackupScheduleFailure(scheduleId, "failed", message, "verify");
    }
    throw new Error(message);
  }
  return { backupId, verifiedAt, checksum: backup.checksum, testArchive: options.testArchive === true };
}

export async function runVolumeClone(
  sourceHostId: string,
  targetHostId: string,
  sourceVolumeName: string,
  targetVolumeName: string,
  overwrite = false,
  linkedBackupId?: string,
  executionFence?: JobExecutionFence,
  operationJobId?: string
) {
  if (overwrite) {
    throw new Error(
      "Overwrite clone restore is disabled because merging into an existing volume cannot be rolled back safely"
    );
  }
  await executionCheckpoint(executionFence);
  const backup = linkedBackupId
    ? await getBackup(linkedBackupId)
    : await createBackupRecord(sourceHostId, sourceVolumeName);
  if (!backup || backup.hostId !== sourceHostId || backup.kind !== "volume" || backup.volumeName !== sourceVolumeName) {
    throw new Error("Volume clone backup link is invalid");
  }
  await runVolumeBackup(sourceHostId, backup.id, sourceVolumeName, executionFence);
  await executionCheckpoint(executionFence);
  const restore = await runVolumeRestore(
    targetHostId,
    backup.id,
    targetVolumeName,
    false,
    executionFence,
    operationJobId
  );
  return { backupId: backup.id, targetHostId, targetVolumeName, ...restore };
}
