import type { RecoveryPointDetail } from "@composebastion/shared";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { deleteRemoteArtifact } from "./recoveryRemoteStorage.js";

function remoteObjectKey(metadata: Record<string, unknown>) {
  const key = metadata.remoteObjectKey;
  return typeof key === "string" && key ? key : null;
}

export async function deleteRecoveryPointRemoteArtifacts(point: RecoveryPointDetail) {
  const targetCache = new Map<string, Awaited<ReturnType<typeof loadWorkerBackupTarget>>>();
  const deletedObjectKeys: string[] = [];

  for (const artifact of point.artifacts) {
    const objectKey = remoteObjectKey(artifact.metadata);
    if (!objectKey) continue;

    const backupTargetId = artifact.backupTargetId ?? point.backupTargetId;
    if (!backupTargetId) {
      throw new Error(`Recovery artifact ${artifact.storageKey} has a remote object but no backup target`);
    }

    let target = targetCache.get(backupTargetId);
    if (!target) {
      target = await loadWorkerBackupTarget(backupTargetId);
      targetCache.set(backupTargetId, target);
    }

    if (target.kind !== "s3" && target.kind !== "rclone") {
      throw new Error(`Recovery artifact ${artifact.storageKey} remote target does not support deletes`);
    }

    await deleteRemoteArtifact(target, objectKey);
    deletedObjectKeys.push(objectKey);
  }

  return { deletedObjectKeys };
}
