import type { RecoveryPointDetail } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { deleteRecoveryPoint } from "./recoveryPointDelete.js";

function retentionMetadata(point: RecoveryPointDetail) {
  const scheduleId = point.metadata.scheduleId;
  const retentionCount = Number(point.metadata.retentionCount);
  if (typeof scheduleId !== "string" || !scheduleId) return null;
  if (!Number.isInteger(retentionCount) || retentionCount < 1) return null;
  return { scheduleId, retentionCount };
}

export async function enforceScheduledRecoveryRetention(point: RecoveryPointDetail) {
  const metadata = retentionMetadata(point);
  if (!metadata) return { deletedIds: [], failures: [] };

  const result = await query<{ id: string }>(
    `SELECT id
     FROM recovery_points
     WHERE trigger_kind = 'scheduled'
       AND metadata->>'scheduleId' = $1
       AND status IN ('completed', 'partial')
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     OFFSET $2`,
    [metadata.scheduleId, metadata.retentionCount]
  );

  const deletedIds: string[] = [];
  const failures: string[] = [];
  for (const row of result.rows) {
    try {
      if (await deleteRecoveryPoint(row.id)) deletedIds.push(row.id);
    } catch (error) {
      failures.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    await query(
      `UPDATE recovery_points
       SET metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [point.id, JSON.stringify({ retentionCleanupFailures: failures })]
    );
  }

  return { deletedIds, failures };
}
