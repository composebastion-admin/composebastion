import { readFile, rm, stat } from "node:fs/promises";
import type { RecoveryArtifact, RecoveryPointDetail } from "@dockermender/shared";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { downloadRemoteArtifactAtomically } from "./recoveryRemoteStorage.js";
import { hashFile, safeRecoveryPointFile } from "./recoveryStorage.js";

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function remoteObjectKeyForArtifact(artifact: RecoveryArtifact) {
  const remoteObjectKey = artifact.metadata.remoteObjectKey;
  return typeof remoteObjectKey === "string" && remoteObjectKey ? remoteObjectKey : null;
}

async function verifyRecoveryArtifactFile(artifact: RecoveryArtifact, filePath: string) {
  const fileStat = await stat(filePath);
  if (artifact.sizeBytes != null && fileStat.size !== artifact.sizeBytes) {
    throw new Error(
      `Recovery artifact ${artifact.storageKey} size mismatch: expected ${artifact.sizeBytes}, got ${fileStat.size}`
    );
  }
  if (artifact.checksum) {
    const checksum = await hashFile(filePath);
    if (checksum !== artifact.checksum) {
      throw new Error(`Recovery artifact ${artifact.storageKey} checksum mismatch`);
    }
  }
  return { sizeBytes: fileStat.size };
}

export async function ensureRecoveryArtifactLocalPath(point: RecoveryPointDetail, artifact: RecoveryArtifact) {
  const localPath = safeRecoveryPointFile(point.id, artifact.storageKey);
  let localVerificationError: unknown = null;
  try {
    await verifyRecoveryArtifactFile(artifact, localPath);
    return localPath;
  } catch (error) {
    if (!isMissingFile(error)) {
      localVerificationError = error;
    }
  }

  const remoteObjectKey = remoteObjectKeyForArtifact(artifact);
  const backupTargetId = artifact.backupTargetId ?? point.backupTargetId;
  if (!remoteObjectKey || !backupTargetId) {
    if (localVerificationError) throw localVerificationError;
    throw new Error(`Recovery artifact ${artifact.storageKey} is missing locally and has no remote copy`);
  }

  const target = await loadWorkerBackupTarget(backupTargetId);
  try {
    await downloadRemoteArtifactAtomically(target, remoteObjectKey, localPath);
    await verifyRecoveryArtifactFile(artifact, localPath);
  } catch (error) {
    await rm(localPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return localPath;
}

export async function readRecoveryArtifact(point: RecoveryPointDetail, artifact: RecoveryArtifact) {
  const localPath = await ensureRecoveryArtifactLocalPath(point, artifact);
  return readFile(localPath);
}
