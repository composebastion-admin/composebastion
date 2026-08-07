import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const DEFAULT_BACKUP_ROOT = "/data/backups";
export const STORAGE_HELPER_PATH = "/usr/local/bin/composebastion-prepare-storage";
const execFileAsync = promisify(execFile);

export function numericIdentity(name, raw, fallback = "1000") {
  const valueText = raw || fallback;
  if (!/^\d+$/.test(valueText)) throw new Error(`${name} must be a numeric identity`);
  const value = Number(valueText);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} must be between 1 and 2147483647`);
  }
  return value;
}

export async function prepareBackupStorage({
  backupRoot = DEFAULT_BACKUP_ROOT,
  targetUid = numericIdentity("COMPOSEBASTION_UID", process.env.COMPOSEBASTION_UID),
  targetGid = numericIdentity("COMPOSEBASTION_GID", process.env.COMPOSEBASTION_GID),
  requireContainerRoot = true,
  helperPath = process.env.COMPOSEBASTION_STORAGE_HELPER_PATH || STORAGE_HELPER_PATH
} = {}) {
  if (requireContainerRoot && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
    throw new Error("Backup storage preparation must run as container root");
  }
  if (path.resolve(backupRoot) !== backupRoot || backupRoot === path.parse(backupRoot).root) {
    throw new Error("Backup storage preparation root is unsafe");
  }

  await mkdir(backupRoot, { recursive: true, mode: 0o750 });
  const rootStats = await lstat(backupRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Backup storage root must be a real directory");
  }

  const { stdout } = await execFileAsync(helperPath, [backupRoot, String(targetUid), String(targetGid)], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Backup storage helper returned an invalid result");
  }
  if (!Number.isSafeInteger(result?.changed) || result.changed < 0
      || !Number.isSafeInteger(result?.symlinksSkipped) || result.symlinksSkipped < 0) {
    throw new Error("Backup storage helper returned an invalid result");
  }
  return { backupRoot, targetUid, targetGid, ...result };
}

async function main() {
  const result = await prepareBackupStorage();
  console.info(
    `Prepared ${result.backupRoot} for ${result.targetUid}:${result.targetGid}; `
    + `changed ${result.changed} path(s), skipped ${result.symlinksSkipped} symlink(s).`
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
