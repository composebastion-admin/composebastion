import { v4 as uuid } from "uuid";
import type { RecoveryPointDetail } from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";
import {
  mapRecoveryArtifact,
  mapRecoveryPoint,
  recoveryArtifactEvidenceCounts
} from "./mappers.js";
import { deleteRecoveryPointRemoteArtifacts } from "./recoveryArtifactDelete.js";
import { deleteRecoveryPointLocalFiles } from "./recoveryStorage.js";

const RECOVERY_DELETION_CLAIM_HEARTBEAT_MS = 30_000;
export const RECOVERY_POINT_DELETION_RECONCILIATION_QUIESCENCE_MS =
  11 * 60_000;

export function recoveryPointHasDeletionClaim(metadata: unknown) {
  return typeof metadata === "object"
    && metadata !== null
    && typeof (metadata as Record<string, unknown>).deletionClaimToken === "string"
    && ((metadata as Record<string, unknown>).deletionClaimToken as string).length > 0;
}

function deletionTimestampIsQuiescent(
  value: unknown,
  nowMs: number
) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && parsed <= nowMs
      - RECOVERY_POINT_DELETION_RECONCILIATION_QUIESCENCE_MS;
}

async function finishClaimedRecoveryPointDeletion(
  point: RecoveryPointDetail,
  deletionClaimToken: string,
  reconciliationToken?: string
) {
  const heartbeat = () => {
    const now = new Date().toISOString();
    const metadata = reconciliationToken
      ? {
          deletionClaimedAt: now,
          deletionReconciliationStartedAt: now
        }
      : { deletionClaimedAt: now };
    return query(
      `UPDATE recovery_points
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
        point.id,
        deletionClaimToken,
        JSON.stringify(metadata),
        reconciliationToken ?? null
      ]
    );
  };
  const claimHeartbeat = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, RECOVERY_DELETION_CLAIM_HEARTBEAT_MS);
  claimHeartbeat.unref();
  try {
    await deleteRecoveryPointRemoteArtifacts(point);
    await deleteRecoveryPointLocalFiles(point.id);
    const deleted = await withTransaction(async (client) => {
      const claimed = await client.query(
        "SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE",
        [point.id]
      );
      const current = claimed.rows[0];
      const currentMetadata =
        current?.metadata
        && typeof current.metadata === "object"
          ? current.metadata as Record<string, unknown>
          : {};
      const ownsClaim =
        currentMetadata.deletionClaimToken
          === deletionClaimToken;
      const ownsReconciliation = reconciliationToken
        ? currentMetadata.deletionReconciliationToken
            === reconciliationToken
        : typeof currentMetadata
            .deletionReconciliationToken !== "string";
      if (!current || !ownsClaim || !ownsReconciliation) {
        return { rowCount: 0 };
      }
      const pending = await client.query(
        `SELECT id
         FROM recovery_restore_attempts
         WHERE recovery_point_id = $1
           AND status IN (
             'active',
             'awaiting_disposition',
             'cleanup_pending',
             'reconciling'
           )
         ORDER BY id
         LIMIT 1`,
        [point.id]
      );
      if (pending.rows.length) {
        throw Object.assign(
          new Error(
            "Recovery point deletion was interrupted by an active restore attempt"
          ),
          { statusCode: 409 }
        );
      }
      await client.query(
        `DELETE FROM recovery_restore_attempts
         WHERE recovery_point_id = $1
           AND status IN ('retained', 'cleaned')`,
        [point.id]
      );
      return client.query(
        `DELETE FROM recovery_points
         WHERE id = $1
           AND metadata->>'deletionClaimToken' = $2`,
        [point.id, deletionClaimToken]
      );
    });
    if (deleted.rowCount !== 1) {
      throw Object.assign(
        new Error(
          "Recovery point deletion lost its claim after storage cleanup; database reconciliation is required"
        ),
        { statusCode: 409 }
      );
    }
  } finally {
    clearInterval(claimHeartbeat);
  }
}

export async function deleteRecoveryPoint(
  id: string,
  onDeletionClaimed?: (
    client: PoolClient,
    point: RecoveryPointDetail
  ) => Promise<void>
) {
  const deletionClaimToken = uuid();
  const point = await withTransaction(async (client) => {
    const selected = await client.query(
      "SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = selected.rows[0];
    if (!row) return null;
    if (row.status === "queued" || row.status === "running") {
      throw Object.assign(
        new Error("A queued or running recovery point cannot be deleted"),
        { statusCode: 409 }
      );
    }
    // A heartbeat timestamp is diagnostic only. Automatically stealing an old
    // claim could leave the prior deleter running against newly admitted work.
    if (recoveryPointHasDeletionClaim(row.metadata)) {
      throw Object.assign(
        new Error(
          "A recovery point deletion claim already exists; reconciliation is required before another deletion attempt"
        ),
        { statusCode: 409 }
      );
    }
    const activeOperation = await client.query(
      `SELECT 1
       FROM operation_jobs job
       WHERE job.status IN ('queued', 'running')
         AND (
           job.payload->>'recoveryPointId' = $1
           OR EXISTS (
             SELECT 1
             FROM migration_runs run
             WHERE run.id::text = job.payload->>'migrationRunId'
               AND (
                 run.recovery_point_id = $1::uuid
                 OR run.id = $2::uuid
               )
           )
         )
       LIMIT 1`,
      [id, row.migration_run_id ?? null]
    );
    if (activeOperation.rows.length) {
      throw Object.assign(
        new Error("A recovery point with an active operation cannot be deleted"),
        { statusCode: 409 }
      );
    }
    const restoreAttempts = await client.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM recovery_restore_attempts
       WHERE recovery_point_id = $1
       ORDER BY id`,
      [id]
    );
    const activeRestoreAttempt = restoreAttempts.rows.find(
      (attempt) => [
        "active",
        "awaiting_disposition",
        "cleanup_pending",
        "reconciling"
      ].includes(attempt.status)
    );
    if (activeRestoreAttempt) {
      throw Object.assign(
        new Error(
          "A recovery point with an active or unreconciled restore attempt cannot be deleted"
        ),
        { statusCode: 409 }
      );
    }
    await client.query(
      `UPDATE recovery_points
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
    const artifacts = await client.query(
      "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
      [id]
    );
    const mappedArtifacts = artifacts.rows.map(mapRecoveryArtifact);
    const claimedPoint = {
      ...mapRecoveryPoint(row),
      ...recoveryArtifactEvidenceCounts(mappedArtifacts),
      artifacts: mappedArtifacts
    } satisfies RecoveryPointDetail;
    // Commit required audit/intention together with the deletion claim.
    // Nothing external is touched if this callback fails.
    await onDeletionClaimed?.(client, claimedPoint);
    return claimedPoint;
  });
  if (!point) return null;
  await finishClaimedRecoveryPointDeletion(
    point,
    deletionClaimToken
  );
  return point;
}

export async function reconcileClaimedRecoveryPointDeletions(
  limit = 10,
  now = new Date()
) {
  const claimed = await withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT *
       FROM recovery_points
       WHERE NULLIF(metadata->>'deletionClaimToken', '') IS NOT NULL
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))]
    );
    const candidates: Array<{
      point: RecoveryPointDetail;
      deletionClaimToken: string;
      reconciliationToken: string;
    }> = [];
    for (const row of selected.rows) {
      const metadata =
        row.metadata
        && typeof row.metadata === "object"
          ? row.metadata as Record<string, unknown>
          : {};
      if (
        !deletionTimestampIsQuiescent(
          metadata.deletionClaimedAt,
          now.getTime()
        )
      ) {
        continue;
      }
      if (
        typeof metadata.deletionReconciliationToken === "string"
        && !deletionTimestampIsQuiescent(
          metadata.deletionReconciliationStartedAt,
          now.getTime()
        )
      ) {
        continue;
      }
      const active = await client.query(
        `SELECT 1
         FROM operation_jobs job
         WHERE job.status IN ('queued', 'running')
           AND (
             job.payload->>'recoveryPointId' = $1
             OR EXISTS (
               SELECT 1
               FROM migration_runs run
               WHERE run.id::text =
                   job.payload->>'migrationRunId'
                 AND (
                   run.recovery_point_id = $1::uuid
                   OR run.id = $2::uuid
                 )
             )
           )
         LIMIT 1`,
        [row.id, row.migration_run_id ?? null]
      );
      if (active.rows[0]) continue;
      const pending = await client.query(
        `SELECT 1
         FROM recovery_restore_attempts
         WHERE recovery_point_id = $1
           AND status IN (
             'active',
             'awaiting_disposition',
             'cleanup_pending',
             'reconciling'
           )
         LIMIT 1`,
        [row.id]
      );
      if (pending.rows[0]) continue;
      const deletionClaimToken = String(
        metadata.deletionClaimToken
      );
      const reconciliationToken = uuid();
      const startedAt = now.toISOString();
      const updated = await client.query(
        `UPDATE recovery_points
         SET metadata = metadata || $3::jsonb
         WHERE id = $1
           AND metadata->>'deletionClaimToken' = $2
         RETURNING *`,
        [
          row.id,
          deletionClaimToken,
          JSON.stringify({
            deletionClaimedAt: startedAt,
            deletionReconciliationToken:
              reconciliationToken,
            deletionReconciliationStartedAt: startedAt
          })
        ]
      );
      if (!updated.rows[0]) continue;
      const artifacts = await client.query(
        `SELECT *
         FROM recovery_artifacts
         WHERE recovery_point_id = $1
         ORDER BY created_at ASC`,
        [row.id]
      );
      const mappedArtifacts =
        artifacts.rows.map(mapRecoveryArtifact);
      candidates.push({
        point: {
          ...mapRecoveryPoint(updated.rows[0]),
          ...recoveryArtifactEvidenceCounts(
            mappedArtifacts
          ),
          artifacts: mappedArtifacts
        },
        deletionClaimToken,
        reconciliationToken
      });
    }
    return candidates;
  });
  let deleted = 0;
  let failed = 0;
  for (const candidate of claimed) {
    try {
      await finishClaimedRecoveryPointDeletion(
        candidate.point,
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
