import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";
import { safeErrorMessage } from "./operationLogs.js";
import { startContainersOneByOne } from "./recoveryContainerControl.js";

type RestartObligation = {
  id: string;
  hostId: string;
  containerIds: string[];
  token: string;
};

export const RECOVERY_SOURCE_RESTART_CLAIM_STALE_MS = 2 * 60_000;
export const RECOVERY_SOURCE_RESTART_CLAIM_HEARTBEAT_MS = 30_000;

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => (
        typeof item === "string" && item.length > 0
      )))]
    : [];
}

async function claimRecoverySourceRestartObligations(limit: number) {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      host_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT point.id, point.host_id, point.metadata
       FROM recovery_points point
       WHERE point.metadata->>'sourceRestartPending' = 'true'
         AND point.metadata->>'sourceRestartReconciliationState'
           IS DISTINCT FROM 'blocked_target_cleanup'
         AND COALESCE(point.metadata->>'sourceRestartTargetCleanupBlocked', 'false') <> 'true'
         AND (
           point.metadata->>'sourceRestartReconciliationState' IS DISTINCT FROM 'running'
           OR NULLIF(point.metadata->>'sourceRestartReconciliationStartedAt', '') IS NULL
           OR CASE
             WHEN COALESCE(point.metadata->>'sourceRestartReconciliationStartedAt', '')
               ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
             THEN (point.metadata->>'sourceRestartReconciliationStartedAt')::timestamptz
               < now() - ($2::double precision * interval '1 millisecond')
             ELSE true
           END
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operation_jobs job
           WHERE job.status IN ('queued', 'running')
             AND (
               job.payload->>'recoveryPointId' = point.id::text
               OR (
                 point.migration_run_id IS NOT NULL
                 AND job.payload->>'migrationRunId' = point.migration_run_id::text
               )
             )
         )
       ORDER BY point.created_at ASC
       FOR UPDATE OF point SKIP LOCKED
       LIMIT $1`,
      [limit, RECOVERY_SOURCE_RESTART_CLAIM_STALE_MS]
    );
    const claimed: RestartObligation[] = [];
    for (const row of selected.rows) {
      const containerIds = stringArray(
        row.metadata.sourceRestartContainerIds
          ?? row.metadata.sourceStoppedIds
          ?? row.metadata.stoppedContainerIds
      );
      const token = randomUUID();
      await client.query(
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [
          row.id,
          JSON.stringify({
            sourceRestartReconciliationState: "running",
            sourceRestartReconciliationToken: token,
            sourceRestartReconciliationStartedAt: new Date().toISOString(),
            sourceRestartReconciliationError: null
          })
        ]
      );
      claimed.push({ id: row.id, hostId: row.host_id, containerIds, token });
    }
    return claimed;
  });
}

async function renewRestartClaim(obligation: RestartObligation) {
  await query(
    `UPDATE recovery_points
     SET metadata = metadata || $3::jsonb
     WHERE id = $1
       AND metadata->>'sourceRestartReconciliationToken' = $2
       AND metadata->>'sourceRestartPending' = 'true'`,
    [
      obligation.id,
      obligation.token,
      JSON.stringify({
        sourceRestartReconciliationStartedAt: new Date().toISOString()
      })
    ]
  );
}

async function recordRestartSuccess(obligation: RestartObligation) {
  await query(
    `UPDATE recovery_points
     SET metadata = (
       metadata
       - 'sourceRestartReconciliationToken'
       - 'sourceRestartReconciliationError'
     ) || $3::jsonb
     WHERE id = $1
       AND metadata->>'sourceRestartReconciliationToken' = $2`,
    [
      obligation.id,
      obligation.token,
      JSON.stringify({
        sourceRestartPending: false,
        sourceRestartContainerIds: [],
        sourceLeftStopped: false,
        sourceStoppedIds: [],
        stoppedContainerIds: [],
        restartFailedIds: [],
        sourceRestartResolvedAt: new Date().toISOString(),
        sourceRestartResolution: "worker_loss_restarted",
        sourceRestartReconciliationState: "completed"
      })
    ]
  );
}

async function recordRestartFailure(obligation: RestartObligation, error: unknown) {
  const restartFailedIds = stringArray(
    (error as { restartFailedIds?: unknown }).restartFailedIds
  );
  const unresolvedIds = restartFailedIds.length ? restartFailedIds : obligation.containerIds;
  await query(
    `UPDATE recovery_points
     SET metadata = (
       metadata
       - 'sourceRestartReconciliationToken'
     ) || $3::jsonb
     WHERE id = $1
       AND metadata->>'sourceRestartReconciliationToken' = $2`,
    [
      obligation.id,
      obligation.token,
      JSON.stringify({
        sourceRestartPending: true,
        sourceRestartContainerIds: unresolvedIds,
        sourceLeftStopped: true,
        sourceStoppedIds: unresolvedIds,
        restartFailedIds: unresolvedIds,
        sourceRestartReconciliationState: "failed",
        sourceRestartReconciliationError: safeErrorMessage(error),
        sourceRestartReconciliationFailedAt: new Date().toISOString()
      })
    ]
  );
}

export async function reconcileRecoverySourceRestartObligations(limit = 10) {
  const obligations = await claimRecoverySourceRestartObligations(limit);
  let restarted = 0;
  let failed = 0;
  for (const obligation of obligations) {
    const claimHeartbeat = setInterval(() => {
      void renewRestartClaim(obligation).catch((error) => {
        console.error("worker.recovery_source_restart.heartbeat", {
          recoveryPointId: obligation.id,
          error: safeErrorMessage(error)
        });
      });
    }, RECOVERY_SOURCE_RESTART_CLAIM_HEARTBEAT_MS);
    claimHeartbeat.unref();
    try {
      if (!obligation.containerIds.length) {
        throw new Error("Recovery source restart obligation has no container identifiers");
      }
      await startContainersOneByOne(obligation.hostId, obligation.containerIds);
      await recordRestartSuccess(obligation);
      restarted += 1;
    } catch (error) {
      await recordRestartFailure(obligation, error);
      failed += 1;
    } finally {
      clearInterval(claimHeartbeat);
    }
  }
  return { checked: obligations.length, restarted, failed };
}
