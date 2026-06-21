import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

export function recoveryPointsRootDir() {
  return path.resolve(env.BACKUP_DIR, "recovery-points");
}

export function recoveryPointDir(recoveryPointId: string) {
  return path.resolve(recoveryPointsRootDir(), recoveryPointId);
}

/** @deprecated Use recoveryPointDir */
export function recoveryRootDir() {
  return recoveryPointsRootDir();
}

export function safeRecoveryPointFile(recoveryPointId: string, relativePath: string) {
  const root = recoveryPointDir(recoveryPointId);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Recovery path escapes recovery point directory");
  }
  return candidate;
}

export function artifactRelativePath(kind: string, name: string) {
  if (kind === "metadata") return "manifest.json";
  if (kind === "compose_yaml") return "compose.yml";
  if (kind === "env_file") return ".env";
  if (kind === "volume") return path.posix.join("volumes", `${name}.tar.gz`);
  if (kind === "host_folder") return path.posix.join("binds", `${name}.tar.gz`);
  return path.posix.join(kind, name);
}

export function safeRecoveryPath(storageKey: string, recoveryPointId?: string) {
  if (recoveryPointId) return safeRecoveryPointFile(recoveryPointId, storageKey);
  const root = recoveryPointsRootDir();
  const candidate = path.resolve(root, storageKey);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Recovery path escapes recovery directory");
  }
  return candidate;
}

export function buildArtifactStorageKey(_recoveryPointId: string, _artifactId: string, kind: string, extension: string) {
  if (kind === "metadata") return "manifest.json";
  if (kind === "compose_yaml") return "compose.yml";
  if (kind === "env_file") return ".env";
  if (kind === "volume") return path.posix.join("volumes", extension.endsWith(".tar.gz") ? extension : `${extension}.tar.gz`);
  if (kind === "host_folder") return path.posix.join("binds", extension.endsWith(".tar.gz") ? extension : `${extension}.tar.gz`);
  return path.posix.join(kind, `${_artifactId}.${extension}`);
}

export async function ensureRecoveryPointDir(recoveryPointId: string) {
  await mkdir(recoveryPointDir(recoveryPointId), { recursive: true });
}

export async function writeRecoveryPointFile(recoveryPointId: string, relativePath: string, content: Buffer | string) {
  await ensureRecoveryPointDir(recoveryPointId);
  const targetPath = safeRecoveryPointFile(recoveryPointId, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
  const fileStat = await stat(targetPath);
  const checksum = await hashFile(targetPath);
  return { path: targetPath, sizeBytes: fileStat.size, checksum };
}

export async function readRecoveryPointFile(recoveryPointId: string, relativePath: string) {
  return readFile(safeRecoveryPointFile(recoveryPointId, relativePath));
}

export async function writeRecoveryBytes(storageKey: string, content: Buffer | string, recoveryPointId?: string) {
  if (!recoveryPointId) throw new Error("recoveryPointId is required");
  return writeRecoveryPointFile(recoveryPointId, storageKey, content);
}

export async function readRecoveryBytes(storageKey: string, recoveryPointId?: string) {
  if (!recoveryPointId) throw new Error("recoveryPointId is required");
  return readRecoveryPointFile(recoveryPointId, storageKey);
}

export async function deleteRecoveryPointLocalFiles(recoveryPointId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(recoveryPointId)) {
    throw new Error("Invalid recovery point id");
  }
  const root = recoveryPointDir(recoveryPointId);
  const pointsRoot = recoveryPointsRootDir();
  if (root !== pointsRoot && !root.startsWith(`${pointsRoot}${path.sep}`)) {
    throw new Error("Refusing to delete outside recovery points root");
  }
  await rm(root, { recursive: true, force: true });
}

export async function hashFile(filePath: string) {
  const root = path.resolve(env.BACKUP_DIR);
  const safePath = path.resolve(filePath);
  if (safePath !== root && !safePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Refusing to hash outside backup directory");
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    // safePath is resolved and confined to BACKUP_DIR above.
    // codeql[js/path-injection]
    createReadStream(safePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return `sha256:${hash.digest("hex")}`;
}

export function logicalStorageKeyForTarget(kind: "local" | "s3", storageKey: string, targetConfig: Record<string, unknown>) {
  if (kind === "local") {
    const basePath = typeof targetConfig.basePath === "string" && targetConfig.basePath
      ? targetConfig.basePath.replace(/\/+$/, "")
      : recoveryPointsRootDir();
    return path.posix.join(basePath.replace(/\\/g, "/"), storageKey);
  }
  const prefix = typeof targetConfig.prefix === "string" ? targetConfig.prefix.replace(/^\/+|\/+$/g, "") : "";
  return prefix ? `${prefix}/${storageKey}` : storageKey;
}
