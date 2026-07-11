import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupListQuerySchema, paginatedResponse, type Backup, type BackupHealthSummary } from "@composebastion/shared";
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
import { loadWorkerBackupTarget, assertBackupTargetS3EndpointAllowed } from "./recoveryBackupTargets.js";
import { deleteRemoteArtifact, downloadRemoteArtifactAtomically, headRemoteArtifact, uploadRemoteArtifact } from "./recoveryRemoteStorage.js";
import { hashFile } from "./recoveryStorage.js";
import { pipeReadableToSshCommand, runSshCommand, streamSshCommandToFile } from "./ssh.js";
import { sanitizeDockerName } from "./recoveryRestoreUtils.js";
import { enqueueJobInTransaction, notifyJobQueued, type JobExecutionFence } from "./jobs.js";

export const BACKUP_DRILL_ROOT = "/var/lib/composebastion/drills";
const BACKUP_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKUP_PROOF_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_HEALTH_ATTENTION_LIMIT = 20;

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

function backupLabel(backup: Pick<Backup, "kind" | "volumeName" | "sourcePath">) {
  return backup.kind === "host_path" ? backup.sourcePath ?? "host path" : backup.volumeName ?? "volume";
}

function backupRemoteObjectKey(backup: Backup) {
  return backup.remoteObjectKey || null;
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

function pipeReadable(input: NodeJS.ReadableStream, transforms: Array<NodeJS.ReadWriteStream | null>) {
  let current = input;
  for (const transform of transforms) {
    if (!transform) continue;
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
  if (!target) throw new Error("Backup target not found");
  if (!target.enabled) throw new Error("Backup target is disabled");
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error("Regular backups currently support S3 and rclone backup targets only");
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

async function persistPreparedBackupRecord(prepared: PreparedBackupRecord, client?: PoolClient) {
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
  const result = client ? await client.query(sql, values) : await query(sql, values);
  const row = result.rows[0];
  if (!row) throw new Error("Failed to create backup record");
  return mapBackup(row);
}

export async function insertPreparedBackupRecord(client: PoolClient, prepared: PreparedBackupRecord) {
  return persistPreparedBackupRecord(prepared, client);
}

export async function createBackupRecord(hostId: string, volumeName: string, options: BackupRecordOptions = {}) {
  return persistPreparedBackupRecord(await prepareBackupRecord(hostId, volumeName, options));
}

export async function createHostPathBackupRecord(hostId: string, sourcePath: string, options: BackupRecordOptions = {}) {
  return persistPreparedBackupRecord(await prepareHostPathBackupRecord(hostId, sourcePath, options));
}

async function createPreparedBackupJobs(preparedRecords: PreparedBackupRecord[], createdBy?: string | null) {
  const result = await withTransaction(async (client) => {
    const backups: Backup[] = [];
    const jobs = [];
    for (const prepared of preparedRecords) {
      const backup = await insertPreparedBackupRecord(client, prepared);
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
      backups.push(backup);
      jobs.push(job);
    }
    return { backups, jobs };
  });
  await Promise.all(result.jobs.map((job) => notifyJobQueued(job.id)));
  return result;
}

export async function createBackupWithJob(
  hostId: string,
  volumeName: string,
  options: BackupRecordOptions = {},
  createdBy?: string | null
) {
  const result = await createPreparedBackupJobs([await prepareBackupRecord(hostId, volumeName, options)], createdBy);
  return { backup: result.backups[0]!, job: result.jobs[0]! };
}

export async function createHostPathBackupWithJob(
  hostId: string,
  sourcePath: string,
  options: BackupRecordOptions = {},
  createdBy?: string | null
) {
  const result = await createPreparedBackupJobs([await prepareHostPathBackupRecord(hostId, sourcePath, options)], createdBy);
  return { backup: result.backups[0]!, job: result.jobs[0]! };
}

export async function createVolumeBackupsWithJobs(hostId: string, volumeNames: string[], createdBy?: string | null) {
  const prepared = await Promise.all(volumeNames.map((volumeName) => prepareBackupRecord(hostId, volumeName)));
  return createPreparedBackupJobs(prepared, createdBy);
}

export async function createVolumeCloneWithJob(input: {
  sourceHostId: string;
  targetHostId: string;
  sourceVolumeName: string;
  targetVolumeName: string;
  overwrite?: boolean;
}, createdBy?: string | null) {
  const prepared = await prepareBackupRecord(input.sourceHostId, input.sourceVolumeName, {
    metadata: {
      operation: "volume.clone",
      targetHostId: input.targetHostId,
      targetVolumeName: input.targetVolumeName
    }
  });
  const result = await withTransaction(async (client) => {
    const backup = await insertPreparedBackupRecord(client, prepared);
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
    return { backup, job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}

export async function getBackup(id: string) {
  const result = await query("SELECT * FROM backups WHERE id = $1", [id]);
  return result.rows[0] ? mapBackup(result.rows[0]) : null;
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
  const objectKey = backupRemoteObjectKey(backup);
  if (!objectKey || !backup.backupTargetId) return null;
  const target = await loadWorkerBackupTarget(backup.backupTargetId);
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error(`Backup ${backup.id} remote target does not support deletes`);
  }
  await assertBackupTargetS3EndpointAllowed(target);
  await deleteRemoteArtifact(target, objectKey);
  return objectKey;
}

export async function deleteBackup(id: string) {
  const backup = await getBackup(id);
  if (!backup) return null;
  const localPath = safeBackupPath(backup.fileName);
  await deleteBackupRemoteObject(backup);
  try {
    await unlink(localPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await query("DELETE FROM backups WHERE id = $1", [id]);
  return backup;
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

export async function ensureBackupLocalPath(backup: Backup) {
  const localPath = safeBackupPath(backup.fileName);
  let localVerificationError: unknown = null;
  try {
    await verifyBackupFile(backup, localPath);
    return localPath;
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
  await downloadRemoteArtifactAtomically(target, objectKey, localPath);
  await verifyBackupFile(backup, localPath);
  return localPath;
}

export async function getBackupFilePath(id: string) {
  const backup = await getBackup(id);
  if (!backup) return null;
  const localPath = await ensureBackupLocalPath(backup);
  return { backup, localPath };
}

export async function getBackupDownloadStream(id: string) {
  const backup = await getBackup(id);
  if (!backup) return null;
  const localPath = safeBackupPath(backup.fileName);
  try {
    await verifyBackupFile(backup, localPath);
    return {
      backup,
      stream: createStoredBackupReadStream(backup, localPath)
    };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const hydratedPath = await ensureBackupLocalPath(backup);
  return {
    backup,
    stream: createStoredBackupReadStream(backup, hydratedPath)
  };
}

async function uploadBackupArtifactToRemote(backup: Backup, localPath: string, checksum: string) {
  if (!backup.backupTargetId) return null;
  const target = await loadWorkerBackupTarget(backup.backupTargetId);
  if (!target.enabled) throw new Error("Backup target is disabled");
  if (target.kind !== "s3" && target.kind !== "rclone") {
    throw new Error("Backup target does not support remote backup artifacts");
  }
  await assertBackupTargetS3EndpointAllowed(target);
  const uploaded = await uploadRemoteArtifact({
    target,
    namespaceId: backup.id,
    storageKey: backup.fileName,
    localPath,
    checksum
  });
  if (!uploaded) return null;
  return {
    remoteObjectKey: uploaded.remoteObjectKey,
    remoteBackend: uploaded.remoteBackend,
    remoteSizeBytes: uploaded.remoteSizeBytes,
    remoteEtag: uploaded.remoteEtag,
    localCachePolicy: target.localCachePolicy
  };
}

async function removeRemoteOnlyLocalArtifact(
  backupId: string,
  localPath: string,
  remoteObjectKey: string,
  checksum: string
) {
  try {
    await rm(localPath, { force: true });
  } catch (cleanupError) {
    const cleanupMessage = errorMessage(cleanupError);
    try {
      await query(
        `UPDATE backups
         SET metadata = metadata || $4::jsonb
         WHERE id = $1
           AND status = 'completed'
           AND remote_object_key = $2
           AND checksum = $3`,
        [
          backupId,
          remoteObjectKey,
          checksum,
          JSON.stringify({ localCacheCleanupError: cleanupMessage })
        ]
      );
    } catch (recordError) {
      console.warn("Failed to remove or record the retained remote-only backup artifact", {
        backupId,
        cleanupError: cleanupMessage,
        recordError: errorMessage(recordError)
      });
    }
  }
}

async function recordCommittedBackupBookkeepingError(
  backupId: string,
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
       SET metadata = metadata || $5::jsonb
       WHERE id = $1
         AND status = $2
         AND checksum = $3
         AND remote_object_key IS NOT DISTINCT FROM $4`,
      [backupId, status, checksum, remoteObjectKey, JSON.stringify({ [field]: message })]
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

async function completeBackupAfterCapture(
  backupId: string,
  sizeBytes: number,
  metadata: Record<string, unknown> = {},
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  const localPath = safeBackupPath(backup.fileName);
  const checksum = await hashFile(localPath);
  const finalMetadata: Record<string, unknown> = { ...metadata };
  let remoteObjectKey: string | null = null;
  let removeLocalAfterCommit = false;
  let status: "completed" | "partial" = "completed";
  let error: string | null = null;

  if (backup.backupTargetId) {
    try {
      await executionCheckpoint(executionFence);
      const upload = await uploadBackupArtifactToRemote(backup, localPath, checksum);
      if (upload) {
        remoteObjectKey = upload.remoteObjectKey;
        finalMetadata.remoteBackend = upload.remoteBackend;
        finalMetadata.remoteSizeBytes = upload.remoteSizeBytes;
        finalMetadata.remoteEtag = upload.remoteEtag;
        finalMetadata.localCachePolicy = upload.localCachePolicy;
        if (upload.localCachePolicy === "remote_only") {
          removeLocalAfterCommit = true;
        }
      }
    } catch (uploadError) {
      status = "partial";
      error = `Remote upload failed: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`;
      finalMetadata.remoteUploadError = error;
    }
  }

  await executionQuery(
    executionFence,
    `UPDATE backups
     SET status = $2,
         size_bytes = $3,
         checksum = $4,
         remote_object_key = $5,
         error = $6,
         completed_at = now(),
         metadata = metadata || $7::jsonb
     WHERE id = $1`,
    [backupId, status, sizeBytes, checksum, remoteObjectKey, error, JSON.stringify(finalMetadata)]
  );

  // A remote-only backup must retain its sole local artifact until the remote
  // locator and integrity metadata have committed through the active job lease.
  // Cleanup is intentionally best-effort after that durability boundary: a
  // retained local copy is harmless, while downgrading the committed backup or
  // deleting before the update succeeds would make recovery ambiguous.
  if (removeLocalAfterCommit && remoteObjectKey) {
    await removeRemoteOnlyLocalArtifact(backupId, localPath, remoteObjectKey, checksum);
  }

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
        backupId,
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
      backupId,
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

  await executionQuery(executionFence, "UPDATE backups SET status = 'running', error = null WHERE id = $1", [backupId]);

  try {
    const host = await getHostForWorker(hostId);
    await executionCheckpoint(executionFence);
    if (isDemoHost(host.public)) {
      const targetPath = safeBackupPath(backup.fileName);
      await mkdir(path.dirname(targetPath), { recursive: true });
      const content = `ComposeBastion demo backup for ${volumeName}\nCreated: ${new Date().toISOString()}\n`;
      const sizeBytes = await writeBackupBytes(targetPath, content, normalizeBackupEncryption(backup.encryption));
      return { ...(await completeBackupAfterCapture(backupId, sizeBytes, { demo: true, volumeName }, executionFence)), demo: true };
    }
    if (host.connectionMode !== "ssh") {
      throw new Error("Volume backup currently requires SSH host mode.");
    }
    const targetPath = safeBackupPath(backup.fileName);
    const command = withDockerEnv(
      `docker run --rm -v ${shQuote(`${volumeName}:/volume:ro`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar czf - .")}`,
      host.public.dockerSocketPath
    );
    const encryptedResult = await streamSshCommandToFile(
      host.ssh,
      command,
      targetPath,
      10 * 60_000,
      createBackupEncryptTransform(normalizeBackupEncryption(backup.encryption))
    );
    return completeBackupAfterCapture(backupId, encryptedResult.sizeBytes, { stderr: encryptedResult.stderr }, executionFence);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await executionQuery(executionFence, "UPDATE backups SET status = 'failed', error = $2, completed_at = now() WHERE id = $1", [
      backupId,
      message
    ]);
    const scheduleId = backup.metadata.scheduleId;
    if (typeof scheduleId === "string" && scheduleId) {
      await recordBackupScheduleResult(scheduleId, "failed", message);
    }
    throw error;
  }
}

export async function runHostPathBackup(hostId: string, backupId: string, sourcePath: string, executionFence?: JobExecutionFence) {
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "host_path") throw new Error("Backup record is not a host-path backup");
  const normalizedSourcePath = normalizeHostSourcePath(sourcePath || backup.sourcePath || "");

  await executionQuery(executionFence, "UPDATE backups SET status = 'running', error = null WHERE id = $1", [backupId]);

  try {
    const host = await getHostForWorker(hostId);
    await executionCheckpoint(executionFence);
    if (isDemoHost(host.public)) {
      const targetPath = safeBackupPath(backup.fileName);
      const content = `ComposeBastion demo host-path backup for ${normalizedSourcePath}\nCreated: ${new Date().toISOString()}\n`;
      const sizeBytes = await writeBackupBytes(targetPath, content, normalizeBackupEncryption(backup.encryption));
      return { ...(await completeBackupAfterCapture(backupId, sizeBytes, { demo: true, sourcePath: normalizedSourcePath }, executionFence)), demo: true };
    }
    if (host.connectionMode !== "ssh") {
      throw new Error("Host-path backup currently requires SSH host mode.");
    }
    const targetPath = safeBackupPath(backup.fileName);
    const command = buildHostPathCaptureCommand(normalizedSourcePath);
    const result = await streamSshCommandToFile(
      host.ssh,
      command,
      targetPath,
      10 * 60_000,
      createBackupEncryptTransform(normalizeBackupEncryption(backup.encryption))
    );
    return completeBackupAfterCapture(backupId, result.sizeBytes, {
      stderr: result.stderr,
      sourcePath: normalizedSourcePath
    }, executionFence);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await executionQuery(executionFence, "UPDATE backups SET status = 'failed', error = $2, completed_at = now() WHERE id = $1", [
      backupId,
      message
    ]);
    const scheduleId = backup.metadata.scheduleId;
    if (typeof scheduleId === "string" && scheduleId) {
      await recordBackupScheduleResult(scheduleId, "failed", message);
    }
    throw error;
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
    throw new Error(`Volume ${targetVolumeName} already exists. Pass overwrite=true to restore into an existing volume.`);
  }
}

export async function runVolumeRestore(hostId: string, backupId: string, targetVolumeName: string, overwrite = false, executionFence?: JobExecutionFence) {
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "volume") throw new Error("Backup record is not a volume backup");

  const localPath = await ensureBackupLocalPath(backup);

  const host = await getHostForWorker(hostId);
  await executionCheckpoint(executionFence);
  if (isDemoHost(host.public)) {
    if (!overwrite && await demoVolumeExists(hostId, targetVolumeName)) {
      throw new Error(`Volume ${targetVolumeName} already exists. Pass overwrite=true to restore into an existing volume.`);
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
          Mountpoint: `/var/lib/docker/volumes/${targetVolumeName}/_data`,
          Scope: "local",
          Labels: { "composebastion.demo.restore": backupId }
        }
      ]
    );
    return { stdout: `Demo restore completed into ${targetVolumeName}`, stderr: "", demo: true };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Volume restore currently requires SSH host mode.");
  }
  await assertSshVolumeCanBeRestored(host.ssh, host.public.dockerSocketPath, targetVolumeName, overwrite);
  await executionCheckpoint(executionFence);
  const createResult = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker volume create ${shQuote(targetVolumeName)}`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (createResult.code !== 0) {
    throw new Error(createResult.stderr || createResult.stdout || `Failed to create volume ${targetVolumeName}`);
  }
  await executionCheckpoint(executionFence);
  const restoreCommand = withDockerEnv(
    `docker run --rm -i -v ${shQuote(`${targetVolumeName}:/volume`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar xzf -")}`,
    host.public.dockerSocketPath
  );
  const result = await pipeReadableToSshCommand(host.ssh, createStoredBackupReadStream(backup, localPath), restoreCommand);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Restore failed");
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function runHostPathRestore(hostId: string, backupId: string, targetPath: string, overwrite = false, executionFence?: JobExecutionFence) {
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  if (backup.kind !== "host_path") throw new Error("Backup record is not a host-path backup");
  const normalizedTargetPath = normalizeHostTargetPath(targetPath);
  const localPath = await ensureBackupLocalPath(backup);

  const host = await getHostForWorker(hostId);
  await executionCheckpoint(executionFence);
  if (isDemoHost(host.public)) {
    return { stdout: `Demo host-path restore completed into ${normalizedTargetPath}`, stderr: "", demo: true };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Host-path restore currently requires SSH host mode.");
  }
  await assertHostPathCanBeRestored(host.ssh, normalizedTargetPath, overwrite);
  await executionCheckpoint(executionFence);
  const restoreCommand = buildHostPathRestoreCommand(normalizedTargetPath);
  const result = await pipeReadableToSshCommand(host.ssh, createStoredBackupReadStream(backup, localPath), restoreCommand);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Host-path restore failed");
  return { stdout: result.stdout, stderr: result.stderr, targetPath: normalizedTargetPath };
}

async function verifyBackupRemoteObject(backup: Backup, failures: string[]) {
  const objectKey = backupRemoteObjectKey(backup);
  if (!objectKey || !backup.backupTargetId) return;
  try {
    const target = await loadWorkerBackupTarget(backup.backupTargetId);
    if (target.kind !== "s3" && target.kind !== "rclone") {
      failures.push("remote target does not support verification");
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

export async function runBackupDrill(hostId: string, backupId: string, executionFence?: JobExecutionFence) {
  await executionCheckpoint(executionFence);
  const backup = await getBackup(backupId);
  if (!backup) throw new Error("Backup record not found");
  const drillId = randomUUID();
  const startedAt = new Date().toISOString();

  try {
    if (backup.status !== "completed" && backup.status !== "partial") {
      throw new Error("Only completed or partial backups can be drilled");
    }
    const localPath = await ensureBackupLocalPath(backup);
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
      const drill = await runBackupDrillWithTeardown(async () => {
        await executionCheckpoint(executionFence);
        const create = await runSshCommand(
          host.ssh,
          withDockerEnv(`docker volume create ${shQuote(scratchVolume)}`, host.public.dockerSocketPath),
          { timeoutMs: 60_000 }
        );
        if (create.code !== 0) throw new Error(create.stderr || create.stdout || `Failed to create drill volume ${scratchVolume}`);

        const restoreCommand = withDockerEnv(
          `docker run --rm -i -v ${shQuote(`${scratchVolume}:/volume`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar xzf -")}`,
          host.public.dockerSocketPath
        );
        await executionCheckpoint(executionFence);
        const restore = await pipeReadableToSshCommand(host.ssh, createStoredBackupReadStream(backup, localPath), restoreCommand);
        if (restore.code !== 0) throw new Error(restore.stderr || restore.stdout || "Drill restore failed");

        const metrics = await runSshCommand(host.ssh, buildVolumeDrillMetricsCommand(scratchVolume, host.public.dockerSocketPath), { timeoutMs: 120_000 });
        if (metrics.code !== 0) throw new Error(metrics.stderr || metrics.stdout || "Failed to inspect drill volume");
        return parseDrillMetrics(metrics.stdout);
      }, async () => {
        const cleanup = await runSshCommand(
          host.ssh,
          withDockerEnv(`docker volume rm -f ${shQuote(scratchVolume)}`, host.public.dockerSocketPath),
          { timeoutMs: 60_000 }
        );
        if (cleanup.code !== 0) throw new Error(cleanup.stderr || cleanup.stdout || `Failed to remove drill volume ${scratchVolume}`);
      });
      const result = {
        backupId,
        drillId,
        status: "completed" as const,
        scratchTarget: scratchVolume,
        ...drill.result,
        cleanupError: drill.cleanupError
      };
      await recordBackupDrillResult(backupId, "completed", { ...result, startedAt, completedAt: new Date().toISOString() }, executionFence);
      return result;
    }

    const scratchPath = buildBackupDrillPath(backup.id, drillId);
    const drill = await runBackupDrillWithTeardown(async () => {
      await executionCheckpoint(executionFence);
      const restore = await pipeReadableToSshCommand(host.ssh, createStoredBackupReadStream(backup, localPath), buildHostPathRestoreCommand(scratchPath));
      if (restore.code !== 0) throw new Error(restore.stderr || restore.stdout || "Host-path drill restore failed");

      const metrics = await runSshCommand(host.ssh, buildHostPathDrillMetricsCommand(scratchPath), { timeoutMs: 120_000 });
      if (metrics.code !== 0) throw new Error(metrics.stderr || metrics.stdout || "Failed to inspect host-path drill restore");
      return parseDrillMetrics(metrics.stdout);
    }, async () => {
      const safeScratchPath = assertAllowedBackupDrillPath(scratchPath);
      const cleanup = await runSshCommand(host.ssh, `rm -rf -- ${shQuote(safeScratchPath)}`, { timeoutMs: 60_000 });
      if (cleanup.code !== 0) throw new Error(cleanup.stderr || cleanup.stdout || `Failed to remove drill path ${safeScratchPath}`);
    });
    const result = {
      backupId,
      drillId,
      status: "completed" as const,
      scratchTarget: scratchPath,
      ...drill.result,
      cleanupError: drill.cleanupError
    };
    await recordBackupDrillResult(backupId, "completed", { ...result, startedAt, completedAt: new Date().toISOString() }, executionFence);
    return result;
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
    const localPath = await ensureBackupLocalPath(backup);
    const checksum = await hashFile(localPath);
    if (backup.checksum && backup.checksum !== checksum) {
      failures.push("local checksum mismatch");
    }
    await verifyBackupRemoteObject(backup, failures);
    if (options.testArchive) {
      await testBackupArchiveOnHost(hostId, backup, localPath);
    }
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
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const backup = linkedBackupId
    ? await getBackup(linkedBackupId)
    : await createBackupRecord(sourceHostId, sourceVolumeName);
  if (!backup || backup.hostId !== sourceHostId || backup.kind !== "volume" || backup.volumeName !== sourceVolumeName) {
    throw new Error("Volume clone backup link is invalid");
  }
  await runVolumeBackup(sourceHostId, backup.id, sourceVolumeName, executionFence);
  await executionCheckpoint(executionFence);
  const restore = await runVolumeRestore(targetHostId, backup.id, targetVolumeName, overwrite, executionFence);
  return { backupId: backup.id, targetHostId, targetVolumeName, ...restore };
}
