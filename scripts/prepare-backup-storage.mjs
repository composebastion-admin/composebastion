import {
  chown,
  lstat,
  mkdir,
  opendir
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BACKUP_ROOT = "/data/backups";

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
  requireContainerRoot = true
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

  let changed = 0;
  let symlinksSkipped = 0;

  async function prepare(candidate, stats = null) {
    const current = stats ?? await lstat(candidate);
    if (current.dev !== rootStats.dev) {
      throw new Error(`Backup storage contains a nested filesystem at ${candidate}`);
    }

    // Ownership of a symlink is irrelevant to access through it. Never chown a
    // path after observing it as a symlink: skipping it also prevents a
    // user-controlled link from redirecting this root one-shot outside the
    // managed tree.
    if (current.isSymbolicLink()) {
      symlinksSkipped += 1;
      return;
    }

    if (current.isDirectory()) {
      const directory = await opendir(candidate);
      for await (const entry of directory) {
        await prepare(path.join(candidate, entry.name));
      }
    }

    if (current.uid === targetUid && current.gid === targetGid) return;
    await chown(candidate, targetUid, targetGid);
    changed += 1;
  }

  await prepare(backupRoot, rootStats);
  return { backupRoot, targetUid, targetGid, changed, symlinksSkipped };
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
