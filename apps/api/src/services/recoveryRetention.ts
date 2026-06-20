import type { RecoveryPointDetail } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { mapRecoveryArtifact, mapRecoveryPoint } from "./mappers.js";
import { deleteRecoveryPointRemoteArtifacts } from "./recoveryArtifactDelete.js";
import { deleteRecoveryPointLocalFiles } from "./recoveryStorage.js";

function retentionMetadata(point: RecoveryPointDetail) {
  const scheduleId = point.metadata.scheduleId;
  const retentionCount = Number(point.metadata.retentionCount);
  if (typeof scheduleId !== "string" || !scheduleId) return null;
  if (!Number.isInteger(retentionCount) || retentionCount < 1) return null;
  return { scheduleId, retentionCount };
}

async function loadRecoveryPointForDelete(id: string): Promise<RecoveryPointDetail | null> {
  const pointResult = await query("SELECT * FROM recovery_points WHERE id = $1", [id]);
  if (!pointResult.rows[0]) return null;
  const artifactResult = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [id]
  );
  return {
    ...mapRecoveryPoint(pointResult.rows[0]),
    artifacts: artifactResult.rows.map(mapRecoveryArtifact)
  };
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
      const stalePoint = await loadRecoveryPointForDelete(row.id);
      if (!stalePoint) continue;
      await deleteRecoveryPointRemoteArtifacts(stalePoint);
      await deleteRecoveryPointLocalFiles(row.id);
      await query("DELETE FROM recovery_points WHERE id = $1", [row.id]);
      deletedIds.push(row.id);
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
