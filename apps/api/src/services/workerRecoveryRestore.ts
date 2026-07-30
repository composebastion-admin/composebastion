import type { RecoveryRestoreRequest } from "@composebastion/shared";
import type { JobExecutionFence } from "./jobs.js";
import {
  runRecoveryRestore,
  runRecoveryRestoreDrill,
  type RestoreResult
} from "./recoveryRestore.js";

export function runWorkerRecoveryRestore(
  hostId: string,
  input: RecoveryRestoreRequest,
  drill: boolean,
  executionFence: JobExecutionFence,
  operationJobId?: string
): Promise<RestoreResult> {
  const executionContext = operationJobId
    ? { operationJobId }
    : undefined;
  if (!executionContext) {
    return drill
      ? runRecoveryRestoreDrill(
          hostId,
          input,
          executionFence
        )
      : runRecoveryRestore(
          hostId,
          input,
          executionFence
        );
  }
  return drill
    ? runRecoveryRestoreDrill(
        hostId,
        input,
        executionFence,
        executionContext
      )
    : runRecoveryRestore(
        hostId,
        input,
        executionFence,
        executionContext
      );
}
