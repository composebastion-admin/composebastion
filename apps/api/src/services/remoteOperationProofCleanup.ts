import { query } from "../db/pool.js";
import { getHostForWorker, listHostIds } from "./hosts.js";
import {
  REMOTE_MUTATION_PROOF_KEY
} from "./remoteMutationProof.js";
import { sweepSshTerminalRemoteOperations } from "./ssh.js";

const OPERATION_ID = /^[0-9a-f]{64}$/;
const MAX_PROTECTED_IDS_PER_HOST = 1_000;

type ProtectedRemoteOperationRow = {
  host_id: string;
  target_host_id: string | null;
  operation_id: string;
};

/**
 * Remove old terminal SSH proof directories that no active or unresolved job
 * can still need. The database protection snapshot is conservative, while the
 * target command applies an additional age grace and strict identity checks to
 * close the race with a newly dispatched operation.
 */
export async function cleanupTerminalRemoteOperationProofs() {
  const protectedRows = await query<ProtectedRemoteOperationRow>(
    `SELECT jobs.host_id,
            NULLIF(jobs.payload->>'targetHostId', '') AS target_host_id,
            jobs.result-> $1 ->> 'operationId' AS operation_id
     FROM operation_jobs AS jobs
     LEFT JOIN deployment_analyses AS analyses
       ON analyses.id::text = jobs.payload->>'analysisId'
     WHERE jobs.result-> $1 ->> 'operationId' IS NOT NULL
       AND (
         jobs.status = 'running'
         OR (
           jobs.status = 'failed'
           AND (
             jobs.error LIKE 'WORKER_LOST%'
             OR jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
             OR analyses.error LIKE 'WORKER_LOST:%'
             OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
           AND COALESCE(
             jobs.result->'remoteOutcomeReconciliation'->>'status',
             ''
           ) <> 'reconciled'
         )
       )`,
    [REMOTE_MUTATION_PROOF_KEY]
  );
  const protectedByHost = new Map<string, Set<string>>();
  for (const row of protectedRows.rows) {
    if (!OPERATION_ID.test(row.operation_id)) continue;
    for (const hostId of [row.host_id, row.target_host_id]) {
      if (!hostId) continue;
      const protectedIds = protectedByHost.get(hostId) ?? new Set<string>();
      protectedIds.add(row.operation_id);
      protectedByHost.set(hostId, protectedIds);
    }
  }

  const hostIds = await listHostIds();
  let checked = 0;
  let removed = 0;
  const failures: Array<{ hostId: string }> = [];
  for (const hostId of hostIds) {
    try {
      const host = await getHostForWorker(hostId);
      if (host.connectionMode !== "ssh") continue;
      checked += 1;
      const protectedIds = [
        ...(protectedByHost.get(hostId) ?? new Set<string>())
      ];
      if (protectedIds.length > MAX_PROTECTED_IDS_PER_HOST) {
        failures.push({ hostId });
        continue;
      }
      const result = await sweepSshTerminalRemoteOperations(
        host.ssh,
        protectedIds,
        {
          maxScanned: 200,
          maxRemoved: 50,
          graceSeconds: 15 * 60
        }
      );
      removed += result.removed;
    } catch {
      // Host connection diagnostics can contain credentials or private URLs.
      // The scheduler logs only the host id and retries the bounded sweep.
      failures.push({ hostId });
    }
  }
  return {
    checked,
    removed,
    failures
  };
}
