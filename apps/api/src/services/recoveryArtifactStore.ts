import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RecoveryArtifact, RecoveryPointDetail } from "@composebastion/shared";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { downloadRemoteArtifactAtomically } from "./recoveryRemoteStorage.js";
import { hashFile, safeRecoveryPointFile } from "./recoveryStorage.js";
import {
  createRecoveryTemporaryDirectory,
  removeTrackedRecoveryTemporaryDirectory
} from "./recoveryTemporaryStorage.js";

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

function artifactRequiresScopedLocalAccess(artifact: RecoveryArtifact) {
  if (artifact.metadata.localCacheRemoved === true) return true;
  if (artifact.metadata.localCacheRemoved === false) return false;
  return artifact.metadata.localCachePolicy === "remote_only"
    && artifact.metadata.remoteVerified === true
    && remoteObjectKeyForArtifact(artifact) !== null;
}

async function prepareRecoveryArtifactLocalPath(
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  allowScopedHydration: boolean
) {
  const localPath = safeRecoveryPointFile(point.id, artifact.storageKey);
  let localVerificationError: unknown = null;
  let localValid = false;
  try {
    await verifyRecoveryArtifactFile(artifact, localPath);
    localValid = true;
  } catch (error) {
    if (!isMissingFile(error)) {
      localVerificationError = error;
    }
  }
  const artifactRemoteOnly = artifactRequiresScopedLocalAccess(artifact);
  if (localValid) {
    if (artifactRemoteOnly) {
      if (!allowScopedHydration) {
        throw new Error("Remote-only recovery artifacts require scoped local access");
      }
      return {
        localPath,
        cleanup: async () => rm(localPath, { force: true })
      };
    }
    return { localPath, cleanup: null };
  }

  const remoteObjectKey = remoteObjectKeyForArtifact(artifact);
  const backupTargetId = artifact.backupTargetId ?? point.backupTargetId;
  if (!remoteObjectKey || !backupTargetId) {
    if (localVerificationError) throw localVerificationError;
    throw new Error(`Recovery artifact ${artifact.storageKey} is missing locally and has no remote copy`);
  }

  const target = await loadWorkerBackupTarget(backupTargetId);
  const remoteOnly = artifactRemoteOnly || target.localCachePolicy === "remote_only";
  if (remoteOnly && !allowScopedHydration) {
    throw new Error("Remote-only recovery artifacts require scoped local access");
  }
  const hydrationDirectory = remoteOnly
    ? await createRecoveryTemporaryDirectory(point.id, ".hydrated", artifact.id)
    : null;
  const hydratedPath = hydrationDirectory
    ? path.join(hydrationDirectory, path.basename(artifact.storageKey))
    : localPath;
  try {
    await downloadRemoteArtifactAtomically(target, remoteObjectKey, hydratedPath);
    await verifyRecoveryArtifactFile(artifact, hydratedPath);
  } catch (operationError) {
    try {
      if (hydrationDirectory) {
        await removeTrackedRecoveryTemporaryDirectory(hydrationDirectory);
      } else {
        await rm(hydratedPath, { force: true });
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Recovery artifact hydration failed (${errorMessage(operationError)}) and its temporary storage could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw operationError;
  }

  return {
    localPath: hydratedPath,
    cleanup: remoteOnly
      ? async () => {
        if (hydrationDirectory) {
          await removeTrackedRecoveryTemporaryDirectory(hydrationDirectory);
        } else {
          await rm(hydratedPath, { force: true });
        }
        if (hydratedPath !== localPath) await rm(localPath, { force: true });
      }
      : null
  };
}

export async function ensureRecoveryArtifactLocalPath(point: RecoveryPointDetail, artifact: RecoveryArtifact) {
  const prepared = await prepareRecoveryArtifactLocalPath(point, artifact, false);
  return prepared.localPath;
}

export async function withRecoveryArtifactLocalPath<T>(
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  useArtifact: (localPath: string) => Promise<T>
) {
  const prepared = await prepareRecoveryArtifactLocalPath(point, artifact, true);
  try {
    return await useArtifact(prepared.localPath);
  } finally {
    await prepared.cleanup?.().catch((error) => {
      console.warn("Failed to clean a hydrated recovery artifact", {
        recoveryPointId: point.id,
        artifactId: artifact.id,
        error: errorMessage(error)
      });
    });
  }
}

export async function withRecoveryArtifactRemotePath<T>(
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  useArtifact: (localPath: string) => Promise<T>
) {
  const remoteObjectKey = remoteObjectKeyForArtifact(artifact);
  const backupTargetId = artifact.backupTargetId ?? point.backupTargetId;
  if (!remoteObjectKey || !backupTargetId) {
    throw new Error(`Recovery artifact ${artifact.storageKey} has no remote locator`);
  }
  const target = await loadWorkerBackupTarget(backupTargetId);
  if (
    (target.kind !== "s3" && target.kind !== "rclone")
    || (target.kind === "s3" && !target.s3)
    || (target.kind === "rclone" && !target.rclone)
  ) {
    throw new Error(`Recovery artifact ${artifact.storageKey} has an invalid remote target`);
  }
  const verificationDirectory = await createRecoveryTemporaryDirectory(
    point.id,
    ".remote-verify",
    artifact.id
  );
  const verificationPath = path.join(verificationDirectory, "artifact");
  let operationCompleted = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    await downloadRemoteArtifactAtomically(target, remoteObjectKey, verificationPath);
    await verifyRecoveryArtifactFile(artifact, verificationPath);
    operationResult = await useArtifact(verificationPath);
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await removeTrackedRecoveryTemporaryDirectory(verificationDirectory);
  } catch (error) {
    cleanupError = error;
  }
  if (!operationCompleted) {
    if (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Remote recovery verification failed (${errorMessage(operationError)}) and its temporary directory could not be removed (${errorMessage(cleanupError)})`
      );
    }
    throw operationError;
  }
  if (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      `Remote recovery verification completed but its temporary directory could not be removed (${errorMessage(cleanupError)})`
    );
  }
  return operationResult;
}

export async function readRecoveryArtifact(point: RecoveryPointDetail, artifact: RecoveryArtifact) {
  return withRecoveryArtifactLocalPath(point, artifact, (localPath) => readFile(localPath));
}
