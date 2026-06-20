import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkerBackupTarget } from "./recoveryBackupTargets.js";
import {
  buildS3ObjectKey,
  createS3Client,
  deleteRecoveryArtifactFromS3,
  downloadRecoveryArtifactFromS3,
  headRecoveryArtifactOnS3,
  uploadRecoveryArtifactToS3
} from "./recoveryS3.js";
import {
  deleteRecoveryArtifactFromRclone,
  downloadRecoveryArtifactFromRclone,
  headRecoveryArtifactOnRclone,
  uploadRecoveryArtifactToRclone
} from "./recoveryRclone.js";

export type RemoteArtifactUpload = {
  remoteObjectKey: string;
  remoteBackend: "s3" | "rclone";
  remoteSizeBytes: number | null;
  remoteEtag: string | null;
};

export type RemoteArtifactHead = {
  sizeBytes: number | null;
  checksum: string | null;
  etag?: string | null;
};

function cleanStorageKey(value: string) {
  return value.replace(/^\/+/, "");
}

export function buildRemoteObjectKey(target: WorkerBackupTarget, namespaceId: string, storageKey: string) {
  if (target.kind === "s3" && target.s3) {
    return buildS3ObjectKey(target.s3.config.prefix, namespaceId, storageKey);
  }
  return [namespaceId, cleanStorageKey(storageKey)].filter(Boolean).join("/").replace(/\/+/g, "/");
}

export async function uploadRemoteArtifact(input: {
  target: WorkerBackupTarget;
  namespaceId: string;
  storageKey: string;
  localPath: string;
  checksum?: string | null;
}): Promise<RemoteArtifactUpload | null> {
  const { target, namespaceId, storageKey, localPath, checksum } = input;
  if (target.kind === "s3" && target.s3) {
    const client = createS3Client(target.s3.config, target.s3.credentials);
    const objectKey = buildRemoteObjectKey(target, namespaceId, storageKey);
    const uploaded = await uploadRecoveryArtifactToS3(client, target.s3.config.bucket, objectKey, localPath, checksum);
    return {
      remoteObjectKey: objectKey,
      remoteBackend: "s3",
      remoteSizeBytes: uploaded.sizeBytes,
      remoteEtag: uploaded.etag
    };
  }
  if (target.kind === "rclone" && target.rclone) {
    const objectKey = buildRemoteObjectKey(target, namespaceId, storageKey);
    const uploaded = await uploadRecoveryArtifactToRclone(target, objectKey, localPath);
    const localStat = await stat(localPath);
    return {
      remoteObjectKey: objectKey,
      remoteBackend: "rclone",
      remoteSizeBytes: uploaded.sizeBytes ?? localStat.size,
      remoteEtag: null
    };
  }
  return null;
}

export async function headRemoteArtifact(target: WorkerBackupTarget, objectKey: string): Promise<RemoteArtifactHead> {
  if (target.kind === "s3" && target.s3) {
    const client = createS3Client(target.s3.config, target.s3.credentials);
    const head = await headRecoveryArtifactOnS3(client, target.s3.config.bucket, objectKey);
    return { sizeBytes: head.sizeBytes, checksum: head.checksum, etag: head.etag };
  }
  if (target.kind === "rclone" && target.rclone) {
    return headRecoveryArtifactOnRclone(target, objectKey);
  }
  throw new Error(`Backup target ${target.name} does not support remote artifact metadata`);
}

export async function downloadRemoteArtifact(target: WorkerBackupTarget, objectKey: string, localPath: string) {
  if (target.kind === "s3" && target.s3) {
    const client = createS3Client(target.s3.config, target.s3.credentials);
    return downloadRecoveryArtifactFromS3(client, target.s3.config.bucket, objectKey, localPath);
  }
  if (target.kind === "rclone" && target.rclone) {
    return downloadRecoveryArtifactFromRclone(target, objectKey, localPath);
  }
  throw new Error(`Backup target ${target.name} does not support remote artifact downloads`);
}

export async function deleteRemoteArtifact(target: WorkerBackupTarget, objectKey: string) {
  if (target.kind === "s3" && target.s3) {
    const client = createS3Client(target.s3.config, target.s3.credentials);
    await deleteRecoveryArtifactFromS3(client, target.s3.config.bucket, objectKey);
    return;
  }
  if (target.kind === "rclone" && target.rclone) {
    await deleteRecoveryArtifactFromRclone(target, objectKey);
    return;
  }
  throw new Error(`Backup target ${target.name} does not support remote artifact deletes`);
}

export async function downloadRemoteArtifactAtomically(target: WorkerBackupTarget, objectKey: string, localPath: string) {
  const tempPath = path.join(path.dirname(localPath), `.download-${path.basename(localPath)}-${randomUUID()}.tmp`);
  try {
    await mkdir(path.dirname(tempPath), { recursive: true });
    const downloaded = await downloadRemoteArtifact(target, objectKey, tempPath);
    await rename(tempPath, localPath);
    return downloaded;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
