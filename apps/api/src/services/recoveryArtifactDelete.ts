import type { RecoveryPointDetail } from "@composebastion/shared";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { deleteRemoteArtifact } from "./recoveryRemoteStorage.js";

function remoteObjectKeys(metadata: Record<string, unknown>) {
  const keys = [
    metadata.remoteObjectKey,
    metadata.orphanRemoteObjectKey,
    ...(Array.isArray(metadata.orphanRemoteObjectKeys) ? metadata.orphanRemoteObjectKeys : [])
  ];
  return [...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0))];
}

export async function deleteRecoveryPointRemoteArtifacts(point: RecoveryPointDetail) {
  const targetCache = new Map<string, Awaited<ReturnType<typeof loadWorkerBackupTarget>>>();
  const deletedObjectKeys: string[] = [];

  for (const artifact of point.artifacts) {
    const objectKeys = remoteObjectKeys(artifact.metadata);
    if (!objectKeys.length) continue;

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

    for (const objectKey of objectKeys) {
      await deleteRemoteArtifact(target, objectKey);
      deletedObjectKeys.push(objectKey);
    }
  }

  return { deletedObjectKeys };
}
