import { createHmac, randomUUID } from "node:crypto";
import { sanitizeUrlDiagnosticText } from "@composebastion/shared";
import type { PoolClient } from "pg";
import { appSecretKey } from "../config/env.js";
import { query, withTransaction } from "../db/pool.js";
import type { WorkerBackupTarget } from "./recoveryBackupTargets.js";
import { constantTimeEqual, decryptSecret, encryptSecret } from "./crypto.js";
import { deleteRemoteArtifact } from "./recoveryRemoteStorage.js";

const REMOTE_ORPHAN_CLAIM_STALE_MS = 5 * 60_000;
export const REMOTE_ARTIFACT_WRITE_INTENT_HEARTBEAT_MS = 60_000;
const TARGET_BINDING_HMAC_DOMAIN = "composebastion:remote-artifact-orphan-target:v1\0";
const REMOTE_WRITE_INTENT_PENDING =
  "Remote artifact write intent is pending authoritative commit or exact-object cleanup";

export type RemoteArtifactOwnerKind =
  | "backup"
  | "recovery_artifact"
  | "backup_target_probe";

export type RemoteArtifactWriteIntent = {
  ownerKind: RemoteArtifactOwnerKind;
  ownerId: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  attemptToken: string;
  claimToken: string;
};

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return String(sanitizeUrlDiagnosticText(raw));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJsonValue(item)])
  );
}

function remoteCleanupTargetSnapshot(target: WorkerBackupTarget): WorkerBackupTarget {
  const common = {
    id: target.id,
    name: target.name,
    enabled: target.enabled,
    config: structuredClone(target.config),
    localCachePolicy: target.localCachePolicy
  };
  if (target.kind === "s3" && target.s3) {
    return {
      ...common,
      kind: "s3",
      s3: structuredClone(target.s3)
    };
  }
  if (target.kind === "rclone" && target.rclone) {
    return {
      ...common,
      kind: "rclone",
      rclone: structuredClone(target.rclone)
    };
  }
  throw new Error(`Backup target ${target.id} is not a configured remote target`);
}

function parseRemoteCleanupTargetSnapshot(value: string): WorkerBackupTarget {
  const parsed = JSON.parse(value) as Partial<WorkerBackupTarget> | null;
  if (
    !parsed
    || typeof parsed !== "object"
    || typeof parsed.id !== "string"
    || typeof parsed.name !== "string"
    || typeof parsed.enabled !== "boolean"
    || !parsed.config
    || typeof parsed.config !== "object"
    || Array.isArray(parsed.config)
    || (parsed.localCachePolicy !== "keep" && parsed.localCachePolicy !== "remote_only")
  ) {
    throw new Error("Remote orphan cleanup target snapshot is invalid");
  }
  if (
    parsed.kind === "s3"
    && parsed.s3
    && typeof parsed.s3 === "object"
    && parsed.s3.config
    && typeof parsed.s3.config === "object"
    && typeof parsed.s3.config.endpoint === "string"
    && typeof parsed.s3.config.bucket === "string"
    && parsed.s3.credentials
    && typeof parsed.s3.credentials === "object"
    && typeof parsed.s3.credentials.accessKeyId === "string"
    && typeof parsed.s3.credentials.secretAccessKey === "string"
  ) {
    return remoteCleanupTargetSnapshot(parsed as WorkerBackupTarget);
  }
  if (
    parsed.kind === "rclone"
    && parsed.rclone
    && typeof parsed.rclone === "object"
    && typeof parsed.rclone.provider === "string"
    && typeof parsed.rclone.remoteName === "string"
    && typeof parsed.rclone.remotePath === "string"
    && (parsed.rclone.configText === null || typeof parsed.rclone.configText === "string")
    && parsed.rclone.credentials
    && typeof parsed.rclone.credentials === "object"
    && !Array.isArray(parsed.rclone.credentials)
  ) {
    return remoteCleanupTargetSnapshot(parsed as WorkerBackupTarget);
  }
  throw new Error("Remote orphan cleanup target snapshot is invalid");
}

/**
 * Bind an orphan to the exact in-memory target configuration that attempted
 * cleanup. The HMAC is domain-separated and keyed by APP_SECRET, so it cannot
 * be used as an offline verifier for low-entropy storage credentials.
 */
export function remoteArtifactTargetBindingFingerprint(target: WorkerBackupTarget) {
  const snapshot = remoteCleanupTargetSnapshot(target);
  const digest = createHmac("sha256", appSecretKey)
    .update(TARGET_BINDING_HMAC_DOMAIN)
    .update(JSON.stringify(stableJsonValue(snapshot)))
    .digest("hex");
  return `hmac-sha256:${digest}`;
}

function validatedRemoteArtifactInput(input: {
  ownerKind: RemoteArtifactOwnerKind;
  ownerId: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  attemptToken: string;
  target: WorkerBackupTarget;
}) {
  const target = remoteCleanupTargetSnapshot(input.target);
  if (target.id !== input.backupTargetId) {
    throw new Error("Remote orphan cleanup target does not match its backup target");
  }
  if (target.kind !== input.backend) {
    throw new Error("Remote orphan cleanup target does not match its backend");
  }
  const targetBindingFingerprint = remoteArtifactTargetBindingFingerprint(target);
  const targetSnapshotEncrypted = encryptSecret(JSON.stringify(target));
  return { targetBindingFingerprint, targetSnapshotEncrypted };
}

/**
 * Persist an exact-object cleanup obligation before any remote PUT/copy can
 * begin. The initial claim is a renewable owner lease: a crashed process stops
 * renewing it, while live backup/recovery owners are also protected by their
 * authoritative database attempt token.
 */
export async function beginRemoteArtifactWriteIntent(input: {
  ownerKind: RemoteArtifactOwnerKind;
  ownerId: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  attemptToken: string;
  target: WorkerBackupTarget;
}): Promise<RemoteArtifactWriteIntent> {
  const { targetBindingFingerprint, targetSnapshotEncrypted } =
    validatedRemoteArtifactInput(input);
  const claimToken = randomUUID();
  const inserted = await query<{ id: string }>(
    `INSERT INTO remote_artifact_orphans (
       id,
       owner_kind,
       owner_id,
       backup_target_id,
       object_key,
       backend,
       attempt_token,
       target_binding_fingerprint,
       target_snapshot_encrypted,
       cleanup_error,
       cleanup_claim_token,
       cleanup_claimed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (backup_target_id, object_key)
     DO UPDATE SET
       backend = EXCLUDED.backend,
       cleanup_error = EXCLUDED.cleanup_error,
       target_binding_fingerprint = EXCLUDED.target_binding_fingerprint,
       target_snapshot_encrypted = EXCLUDED.target_snapshot_encrypted,
       cleanup_claim_token = EXCLUDED.cleanup_claim_token,
       cleanup_claimed_at = EXCLUDED.cleanup_claimed_at,
       updated_at = now()
     WHERE remote_artifact_orphans.owner_kind = EXCLUDED.owner_kind
         AND remote_artifact_orphans.owner_id = EXCLUDED.owner_id
         AND remote_artifact_orphans.attempt_token = EXCLUDED.attempt_token
     RETURNING id`,
    [
      randomUUID(),
      input.ownerKind,
      input.ownerId,
      input.backupTargetId,
      input.objectKey,
      input.backend,
      input.attemptToken,
      targetBindingFingerprint,
      targetSnapshotEncrypted,
      REMOTE_WRITE_INTENT_PENDING,
      claimToken
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error(
      "Remote artifact write intent conflicts with a different owner or attempt"
    );
  }
  return {
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    backupTargetId: input.backupTargetId,
    objectKey: input.objectKey,
    backend: input.backend,
    attemptToken: input.attemptToken,
    claimToken
  };
}

export async function renewRemoteArtifactWriteIntent(
  intent: RemoteArtifactWriteIntent
) {
  const renewed = await query(
    `UPDATE remote_artifact_orphans
     SET cleanup_claimed_at = now(),
         updated_at = now()
     WHERE owner_kind = $1
       AND owner_id = $2
       AND backup_target_id = $3
       AND object_key = $4
       AND backend = $5
       AND attempt_token = $6
       AND cleanup_claim_token = $7`,
    [
      intent.ownerKind,
      intent.ownerId,
      intent.backupTargetId,
      intent.objectKey,
      intent.backend,
      intent.attemptToken,
      intent.claimToken
    ]
  );
  return renewed.rowCount === 1;
}

export async function clearRemoteArtifactWriteIntent(
  intent: Omit<RemoteArtifactWriteIntent, "claimToken">,
  client?: PoolClient
) {
  const text = `DELETE FROM remote_artifact_orphans
     WHERE owner_kind = $1
       AND owner_id = $2
       AND backup_target_id = $3
       AND object_key = $4
       AND backend = $5
       AND attempt_token = $6`;
  const values = [
    intent.ownerKind,
    intent.ownerId,
    intent.backupTargetId,
    intent.objectKey,
    intent.backend,
    intent.attemptToken
  ];
  const cleared = client
    ? await client.query(text, values)
    : await query(text, values);
  return cleared.rowCount === 1;
}

export async function releaseRemoteArtifactWriteIntent(
  intent: Omit<RemoteArtifactWriteIntent, "claimToken">,
  cleanupError: unknown
) {
  const released = await query(
    `UPDATE remote_artifact_orphans
     SET cleanup_error = $7,
         cleanup_claim_token = NULL,
         cleanup_claimed_at = NULL,
         updated_at = now()
     WHERE owner_kind = $1
       AND owner_id = $2
       AND backup_target_id = $3
       AND object_key = $4
       AND backend = $5
       AND attempt_token = $6`,
    [
      intent.ownerKind,
      intent.ownerId,
      intent.backupTargetId,
      intent.objectKey,
      intent.backend,
      intent.attemptToken,
      errorMessage(cleanupError)
    ]
  );
  if (released.rowCount !== 1) {
    throw new Error("Remote artifact write intent is no longer owned by this attempt");
  }
}

export async function recordRemoteArtifactOrphan(input: {
  ownerKind: RemoteArtifactOwnerKind;
  ownerId: string;
  backupTargetId: string;
  objectKey: string;
  backend: "s3" | "rclone";
  attemptToken: string;
  target: WorkerBackupTarget;
  cleanupError: unknown;
}) {
  const { targetBindingFingerprint, targetSnapshotEncrypted } =
    validatedRemoteArtifactInput(input);
  const inserted = await query<{ id: string }>(
    `INSERT INTO remote_artifact_orphans (
       id,
       owner_kind,
       owner_id,
       backup_target_id,
       object_key,
       backend,
       attempt_token,
       target_binding_fingerprint,
       target_snapshot_encrypted,
       cleanup_error
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (backup_target_id, object_key)
     DO UPDATE SET
       backend = EXCLUDED.backend,
       cleanup_error = EXCLUDED.cleanup_error,
       target_binding_fingerprint = EXCLUDED.target_binding_fingerprint,
       target_snapshot_encrypted = EXCLUDED.target_snapshot_encrypted,
       cleanup_claim_token = NULL,
       cleanup_claimed_at = NULL,
       updated_at = now()
     WHERE remote_artifact_orphans.owner_kind = EXCLUDED.owner_kind
       AND remote_artifact_orphans.owner_id = EXCLUDED.owner_id
       AND remote_artifact_orphans.attempt_token = EXCLUDED.attempt_token
     RETURNING id`,
    [
      randomUUID(),
      input.ownerKind,
      input.ownerId,
      input.backupTargetId,
      input.objectKey,
      input.backend,
      input.attemptToken,
      targetBindingFingerprint,
      targetSnapshotEncrypted,
      errorMessage(input.cleanupError)
    ]
  );
  if (inserted.rowCount !== 1) {
    throw new Error(
      "Remote artifact orphan conflicts with a different owner or attempt"
    );
  }
}

async function claimRemoteArtifactOrphans(limit: number) {
  const claimToken = randomUUID();
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      owner_kind: RemoteArtifactOwnerKind;
      owner_id: string;
      backup_target_id: string;
      object_key: string;
      backend: "s3" | "rclone";
      attempt_token: string;
      target_binding_fingerprint: string;
      target_snapshot_encrypted: string;
    }>(
      `SELECT id, owner_kind, owner_id, backup_target_id, object_key, backend,
              attempt_token, target_binding_fingerprint, target_snapshot_encrypted
       FROM remote_artifact_orphans
       WHERE cleanup_claim_token IS NULL
          OR cleanup_claimed_at < now() - ($2::double precision * interval '1 millisecond')
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit, REMOTE_ORPHAN_CLAIM_STALE_MS]
    );
    if (!result.rows.length) return { claimToken, rows: [] };
    const ids = result.rows.map((row) => row.id);
    await client.query(
      `UPDATE remote_artifact_orphans
       SET cleanup_claim_token = $2,
           cleanup_claimed_at = now(),
           updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ids, claimToken]
    );
    return { claimToken, rows: result.rows };
  });
}

type RemoteArtifactOwnerDisposition = "active" | "committed" | "abandoned";

async function remoteArtifactOwnerDisposition(orphan: {
  owner_kind: RemoteArtifactOwnerKind;
  owner_id: string;
  backup_target_id: string;
  object_key: string;
  attempt_token: string;
}): Promise<RemoteArtifactOwnerDisposition> {
  if (orphan.owner_kind === "backup_target_probe") return "abandoned";
  if (orphan.owner_kind === "backup") {
    const result = await query<{
      status: string;
      remote_object_key: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT status, remote_object_key, metadata
       FROM backups
       WHERE id = $1`,
      [orphan.owner_id]
    );
    const backup = result.rows[0];
    if (!backup) return "abandoned";
    if (
      backup.remote_object_key === orphan.object_key
      && backup.metadata?.backupCaptureCommittedToken === orphan.attempt_token
    ) {
      return "committed";
    }
    if (
      backup.status === "running"
      && backup.metadata?.backupCaptureAttemptToken === orphan.attempt_token
      && !backup.metadata?.deletionClaimToken
    ) {
      return "active";
    }
    return "abandoned";
  }

  const result = await query<{
    backup_target_id: string | null;
    artifact_metadata: Record<string, unknown>;
    point_status: string;
    point_metadata: Record<string, unknown>;
  }>(
    `SELECT artifact.backup_target_id,
            artifact.metadata AS artifact_metadata,
            point.status AS point_status,
            point.metadata AS point_metadata
     FROM recovery_artifacts artifact
     JOIN recovery_points point ON point.id = artifact.recovery_point_id
     WHERE artifact.id = $1`,
    [orphan.owner_id]
  );
  const artifact = result.rows[0];
  if (!artifact) return "abandoned";
  if (
    artifact.backup_target_id === orphan.backup_target_id
    && artifact.artifact_metadata?.remoteObjectKey === orphan.object_key
    && artifact.artifact_metadata?.remoteCaptureAttemptToken === orphan.attempt_token
    && artifact.artifact_metadata?.remoteVerified === true
  ) {
    return "committed";
  }
  if (
    artifact.point_status === "running"
    && artifact.point_metadata?.captureAttemptToken === orphan.attempt_token
    && !artifact.point_metadata?.deletionClaimToken
  ) {
    return "active";
  }
  return "abandoned";
}

async function deferActiveRemoteArtifactIntent(id: string, claimToken: string) {
  const deferred = await query(
    `UPDATE remote_artifact_orphans
     SET cleanup_claimed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND cleanup_claim_token = $2`,
    [id, claimToken]
  );
  if (deferred.rowCount !== 1) {
    throw new Error("Remote artifact cleanup lost its durable claim");
  }
}

async function deleteClaimedRemoteArtifactLedger(id: string, claimToken: string) {
  const deleted = await query(
    `DELETE FROM remote_artifact_orphans
     WHERE id = $1
       AND cleanup_claim_token = $2`,
    [id, claimToken]
  );
  if (deleted.rowCount !== 1) {
    throw new Error("Remote orphan cleanup lost its durable claim");
  }
}

export async function reconcileRemoteArtifactOrphans(limit = 25) {
  const claimed = await claimRemoteArtifactOrphans(limit);
  let cleaned = 0;
  let failed = 0;
  for (const orphan of claimed.rows) {
    try {
      const disposition = await remoteArtifactOwnerDisposition(orphan);
      if (disposition === "active") {
        await deferActiveRemoteArtifactIntent(orphan.id, claimed.claimToken);
        continue;
      }
      if (disposition === "committed") {
        await deleteClaimedRemoteArtifactLedger(orphan.id, claimed.claimToken);
        cleaned += 1;
        continue;
      }
      const target = parseRemoteCleanupTargetSnapshot(
        decryptSecret(orphan.target_snapshot_encrypted)
      );
      if (target.id !== orphan.backup_target_id) {
        throw new Error("Remote orphan cleanup target snapshot has the wrong target id");
      }
      if (target.kind !== orphan.backend) {
        throw new Error(
          `Remote orphan backend ${orphan.backend} does not match its encrypted target snapshot`
        );
      }
      const snapshotFingerprint = remoteArtifactTargetBindingFingerprint(target);
      if (!constantTimeEqual(snapshotFingerprint, orphan.target_binding_fingerprint)) {
        throw new Error(
          "Remote orphan cleanup target snapshot failed its authenticated binding check"
        );
      }
      await deleteRemoteArtifact(target, orphan.object_key);
      await deleteClaimedRemoteArtifactLedger(orphan.id, claimed.claimToken);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      await query(
        `UPDATE remote_artifact_orphans
         SET cleanup_error = $3,
             cleanup_claim_token = NULL,
             cleanup_claimed_at = NULL,
             updated_at = now()
         WHERE id = $1
           AND cleanup_claim_token = $2`,
        [orphan.id, claimed.claimToken, errorMessage(error)]
      ).catch(() => undefined);
    }
  }
  return { checked: claimed.rows.length, cleaned, failed };
}
