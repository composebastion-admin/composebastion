import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { decryptSecret } from "./crypto.js";

export type BackupTargetIdentityRow = {
  id?: string;
  kind: string;
  config?: Record<string, unknown> | null;
  provider?: string | null;
  remote_path?: string | null;
  generic_config_encrypted?: string | null;
};

export type BackupTargetReferenceCounts = {
  backups: number;
  backupSchedules: number;
  recoveryPoints: number;
  recoveryArtifacts: number;
  recoverySchedules: number;
};

type BackupTargetLifecycleClient = Pick<pg.PoolClient, "query">;

function nullableText(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizedS3Endpoint(value: unknown) {
  const endpoint = nullableText(value);
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

function normalizedRemotePath(value: unknown) {
  const remotePath = nullableText(value);
  return remotePath ? remotePath.replace(/^\/+|\/+$/g, "") : null;
}

function configRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedRcloneConfig(row: BackupTargetIdentityRow) {
  if (!row.generic_config_encrypted) return null;
  return decryptSecret(row.generic_config_encrypted).replace(/\r\n/g, "\n").trimEnd();
}

export function backupTargetStorageIdentity(row: BackupTargetIdentityRow) {
  const config = configRecord(row.config);
  if (row.kind === "local") {
    return { kind: "local" };
  }
  if (row.kind === "s3") {
    return {
      kind: "s3",
      endpoint: normalizedS3Endpoint(config.endpoint),
      bucket: nullableText(config.bucket),
      prefix: normalizedRemotePath(config.prefix)
    };
  }
  if (row.kind === "rclone") {
    const {
      provider: _provider,
      remoteName: _remoteName,
      remotePath: _remotePath,
      ...providerConfig
    } = config;
    const smb = configRecord(providerConfig.smb);
    if (Object.keys(smb).length > 0) {
      const {
        username: _username,
        domain: _domain,
        password: _password,
        ...storageConfig
      } = smb;
      providerConfig.smb = storageConfig;
    }
    return {
      kind: "rclone",
      provider: nullableText(row.provider ?? config.provider),
      remoteName: nullableText(config.remoteName),
      remotePath: normalizedRemotePath(row.remote_path ?? config.remotePath),
      providerConfig,
      importedConfig: normalizedRcloneConfig(row)
    };
  }
  return { kind: row.kind, config };
}

export function backupTargetStorageIdentityChanged(
  current: BackupTargetIdentityRow,
  next: BackupTargetIdentityRow
) {
  return !isDeepStrictEqual(
    backupTargetStorageIdentity(current),
    backupTargetStorageIdentity(next)
  );
}

export async function lockBackupTarget(
  client: BackupTargetLifecycleClient,
  id: string
): Promise<BackupTargetIdentityRow | null> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`backup-target:${id}`]
  );
  const result = await client.query<BackupTargetIdentityRow>(
    "SELECT * FROM backup_targets WHERE id = $1 FOR UPDATE",
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getBackupTargetReferenceCounts(
  client: BackupTargetLifecycleClient,
  id: string
): Promise<BackupTargetReferenceCounts> {
  const result = await client.query<{
    backups: number | string;
    backup_schedules: number | string;
    recovery_points: number | string;
    recovery_artifacts: number | string;
    recovery_schedules: number | string;
  }>(
    `SELECT
       (SELECT count(*) FROM backups WHERE backup_target_id = $1) AS backups,
       (SELECT count(*) FROM backup_schedules WHERE backup_target_id = $1) AS backup_schedules,
       (SELECT count(*) FROM recovery_points WHERE backup_target_id = $1) AS recovery_points,
       (SELECT count(*) FROM recovery_artifacts WHERE backup_target_id = $1) AS recovery_artifacts,
       (SELECT count(*) FROM recovery_schedules WHERE backup_target_id = $1) AS recovery_schedules`,
    [id]
  );
  const row = result.rows[0] ?? {
    backups: 0,
    backup_schedules: 0,
    recovery_points: 0,
    recovery_artifacts: 0,
    recovery_schedules: 0
  };
  return {
    backups: Number(row.backups ?? 0),
    backupSchedules: Number(row.backup_schedules ?? 0),
    recoveryPoints: Number(row.recovery_points ?? 0),
    recoveryArtifacts: Number(row.recovery_artifacts ?? 0),
    recoverySchedules: Number(row.recovery_schedules ?? 0)
  };
}

export function hasBackupTargetReferences(counts: BackupTargetReferenceCounts) {
  return Object.values(counts).some((count) => count > 0);
}

function referenceSummary(counts: BackupTargetReferenceCounts) {
  return [
    ["backups", counts.backups],
    ["backup schedules", counts.backupSchedules],
    ["recovery points", counts.recoveryPoints],
    ["recovery artifacts", counts.recoveryArtifacts],
    ["recovery schedules", counts.recoverySchedules]
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label}=${count}`)
    .join(", ");
}

export function backupTargetReferenceConflict(
  operation: "delete" | "change storage identity",
  counts: BackupTargetReferenceCounts
) {
  const action = operation === "delete"
    ? "cannot be deleted"
    : "storage identity cannot be changed";
  return Object.assign(
    new Error(`Backup target ${action} while it is referenced (${referenceSummary(counts)}).`),
    {
      statusCode: 409,
      referenceCounts: counts
    }
  );
}

export async function assertBackupTargetIdentityChangeAllowed(
  client: BackupTargetLifecycleClient,
  id: string,
  current: BackupTargetIdentityRow,
  next: BackupTargetIdentityRow
) {
  if (!backupTargetStorageIdentityChanged(current, next)) return;
  const counts = await getBackupTargetReferenceCounts(client, id);
  if (hasBackupTargetReferences(counts)) {
    throw backupTargetReferenceConflict("change storage identity", counts);
  }
}

export async function assertBackupTargetUsableForReference(
  client: BackupTargetLifecycleClient,
  id: string | null | undefined,
  options: { allowedKinds?: ReadonlyArray<"local" | "s3" | "rclone"> } = {}
) {
  if (!id) return null;
  const result = await client.query<{ id: string; kind: string; enabled: boolean }>(
    `SELECT id, kind, enabled
     FROM backup_targets
     WHERE id = $1
     FOR KEY SHARE`,
    [id]
  );
  const target = result.rows[0];
  if (!target) {
    throw Object.assign(new Error("Backup target not found."), { statusCode: 409 });
  }
  const allowedKinds = options.allowedKinds ?? ["local", "s3", "rclone"];
  if (!allowedKinds.includes(target.kind as "local" | "s3" | "rclone")) {
    throw Object.assign(
      new Error(`Backup target kind ${target.kind} is not supported for recovery.`),
      { statusCode: 409 }
    );
  }
  if (!target.enabled) {
    throw Object.assign(new Error("Backup target is disabled."), { statusCode: 409 });
  }
  return {
    id: target.id,
    kind: target.kind as "local" | "s3" | "rclone"
  };
}
