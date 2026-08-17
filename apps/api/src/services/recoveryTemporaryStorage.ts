import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { recoveryPointsRootDir } from "./recoveryStorage.js";

export const RECOVERY_TEMPORARY_MAX_AGE_MS = 15 * 60_000;
export const RECOVERY_TEMPORARY_HEARTBEAT_MS = 60_000;

const RECOVERY_TEMPORARY_DIRECTORY_LEASE = ".composebastion-active";
const RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX = ".composebastion-active";
export const RECOVERY_RECONCILIATION_MARKER = ".composebastion-reconciliation-required";
const RECOVERY_TEMPORARY_NAMESPACES = [
  ".capture",
  ".hydrated",
  ".remote-verify",
  ".remote-verification"
] as const;
const recoveryPointIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeRecoveryTemporaryPaths = new Map<string, NodeJS.Timeout>();

export type RecoveryTemporaryNamespace = typeof RECOVERY_TEMPORARY_NAMESPACES[number];

function isMissingFile(error: unknown) {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExistingPath(error: unknown) {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isOwned(stats: Stats) {
  const uid = currentUid();
  return uid === null || stats.uid === uid;
}

function assertOwnedDirectory(stats: Stats, label: string) {
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) {
    throw new Error(`${label} is not a safe owned directory`);
  }
}

function isPathInside(root: string, candidate: string) {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function isDownloadCandidateName(name: string) {
  return name.startsWith(".download-")
    && name.endsWith(".tmp")
    && name.length > ".download-.tmp".length;
}

function isDownloadLeaseName(name: string) {
  const candidateName = name.slice(0, -RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX.length);
  return name.endsWith(RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX)
    && isDownloadCandidateName(candidateName);
}

async function ensureChildDirectory(parent: string, name: string) {
  const parentStats = await lstat(parent);
  assertOwnedDirectory(parentStats, "Recovery temporary parent");
  const child = path.join(parent, name);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (!isExistingPath(error)) throw error;
  }
  const childStats = await lstat(child);
  assertOwnedDirectory(childStats, "Recovery temporary path");
  return child;
}

async function ensureSafeRecoveryParent(directory: string) {
  const pointsRoot = path.resolve(recoveryPointsRootDir());
  const resolved = path.resolve(directory);
  if (!isPathInside(pointsRoot, resolved)) {
    throw new Error("Recovery temporary path escapes recovery points root");
  }
  const relative = path.relative(pointsRoot, resolved);
  const segments = relative.split(path.sep).filter(Boolean);
  const recoveryPointId = segments.shift();
  if (!recoveryPointId || !recoveryPointIdPattern.test(recoveryPointId)) {
    throw new Error("Recovery temporary path does not belong to a valid recovery point");
  }

  const backupRoot = path.dirname(pointsRoot);
  const backupStats = await lstat(backupRoot);
  assertOwnedDirectory(backupStats, "Backup storage root");
  let current = await ensureChildDirectory(backupRoot, path.basename(pointsRoot));
  current = await ensureChildDirectory(current, recoveryPointId);
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new Error("Invalid recovery temporary path component");
    }
    current = await ensureChildDirectory(current, segment);
  }
  if (current !== resolved) {
    throw new Error("Recovery temporary path normalization mismatch");
  }
}

async function assertSafeExistingRecoveryDirectory(directory: string) {
  const pointsRoot = path.resolve(recoveryPointsRootDir());
  const resolved = path.resolve(directory);
  if (!isPathInside(pointsRoot, resolved)) {
    throw new Error("Recovery temporary path escapes recovery points root");
  }
  const relative = path.relative(pointsRoot, resolved);
  const segments = relative.split(path.sep).filter(Boolean);
  const recoveryPointId = segments.shift();
  if (!recoveryPointId || !recoveryPointIdPattern.test(recoveryPointId)) {
    throw new Error("Recovery temporary path does not belong to a valid recovery point");
  }

  const backupRoot = path.dirname(pointsRoot);
  const backupStats = await lstat(backupRoot);
  assertOwnedDirectory(backupStats, "Backup storage root");
  let current = path.join(backupRoot, path.basename(pointsRoot));
  let currentStats = await lstat(current);
  assertOwnedDirectory(currentStats, "Recovery temporary path");
  for (const segment of [recoveryPointId, ...segments]) {
    current = path.join(current, segment);
    currentStats = await lstat(current);
    assertOwnedDirectory(currentStats, "Recovery temporary path");
  }
  if (current !== resolved) {
    throw new Error("Recovery temporary path normalization mismatch");
  }
  return currentStats;
}

function assertTrackedRecoveryTemporaryDirectoryPath(directory: string) {
  const pointsRoot = path.resolve(recoveryPointsRootDir());
  const resolved = path.resolve(directory);
  if (!isPathInside(pointsRoot, resolved)) {
    throw new Error("Refusing to remove a recovery temporary directory outside recovery storage");
  }
  const segments = path.relative(pointsRoot, resolved).split(path.sep).filter(Boolean);
  const [recoveryPointId, namespace, directoryName] = segments;
  if (
    segments.length !== 3
    || !recoveryPointId
    || !recoveryPointIdPattern.test(recoveryPointId)
    || !namespace
    || !RECOVERY_TEMPORARY_NAMESPACES.includes(namespace as RecoveryTemporaryNamespace)
    || !directoryName
    || !/^[A-Za-z0-9._-]+$/.test(directoryName)
  ) {
    throw new Error("Refusing to remove a path that is not a recovery temporary directory");
  }
  return resolved;
}

async function startRecoveryTemporaryLease(targetPath: string, leasePath: string) {
  const resolvedTarget = path.resolve(targetPath);
  if (activeRecoveryTemporaryPaths.has(resolvedTarget)) {
    throw new Error("Recovery temporary path is already leased by this process");
  }
  await writeFile(leasePath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(leasePath, now, now).catch((error) => {
      if (!isMissingFile(error)) {
        console.warn("Failed to refresh a recovery temporary-path lease", {
          error: errorMessage(error)
        });
      }
    });
  }, RECOVERY_TEMPORARY_HEARTBEAT_MS);
  heartbeat.unref();
  activeRecoveryTemporaryPaths.set(resolvedTarget, heartbeat);
}

function stopRecoveryTemporaryLease(targetPath: string) {
  const resolvedTarget = path.resolve(targetPath);
  const heartbeat = activeRecoveryTemporaryPaths.get(resolvedTarget);
  if (heartbeat) clearInterval(heartbeat);
  activeRecoveryTemporaryPaths.delete(resolvedTarget);
}

export async function createRecoveryTemporaryDirectory(
  recoveryPointId: string,
  namespace: RecoveryTemporaryNamespace,
  prefix: string
) {
  if (!recoveryPointIdPattern.test(recoveryPointId)) {
    throw new Error("Invalid recovery point id for temporary storage");
  }
  if (!RECOVERY_TEMPORARY_NAMESPACES.includes(namespace)) {
    throw new Error("Invalid recovery temporary namespace");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new Error("Invalid recovery temporary-directory prefix");
  }
  const namespacePath = path.resolve(recoveryPointsRootDir(), recoveryPointId, namespace);
  await ensureSafeRecoveryParent(namespacePath);
  const directory = await mkdtemp(path.join(namespacePath, `${prefix}-`));
  try {
    await startRecoveryTemporaryLease(
      directory,
      path.join(directory, RECOVERY_TEMPORARY_DIRECTORY_LEASE)
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return directory;
}

export async function removeTrackedRecoveryTemporaryDirectory(directory: string) {
  const resolved = assertTrackedRecoveryTemporaryDirectoryPath(directory);
  stopRecoveryTemporaryLease(resolved);
  let initialStats;
  try {
    initialStats = await assertSafeExistingRecoveryDirectory(resolved);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (await removeCandidateIfUnchanged(resolved, initialStats, true)) return;
  throw new Error("Recovery temporary directory changed before it could be removed safely");
}

export async function preserveTrackedRecoveryTemporaryDirectory(
  directory: string,
  evidence: Record<string, unknown>
) {
  const resolved = assertTrackedRecoveryTemporaryDirectoryPath(directory);
  await assertSafeExistingRecoveryDirectory(resolved);
  const markerPath = path.join(resolved, RECOVERY_RECONCILIATION_MARKER);
  try {
    await writeFile(
      markerPath,
      `${JSON.stringify({
        reason: "capture_commit_outcome_unknown",
        ...evidence,
        recordedAt: new Date().toISOString()
      })}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (!isExistingPath(error)) throw error;
    const markerStats = await lstat(markerPath);
    if (
      !markerStats.isFile()
      || markerStats.isSymbolicLink()
      || !isOwned(markerStats)
    ) {
      throw new Error("Recovery reconciliation marker is not a safe owned file");
    }
  }
  // The marker is durable across process restarts, so the in-memory lease is
  // no longer needed. Stale cleanup treats the marker as a permanent hold.
  stopRecoveryTemporaryLease(resolved);
}

async function removeRecoveryTemporaryDownloadLease(leasePath: string) {
  try {
    await assertSafeExistingRecoveryDirectory(path.dirname(leasePath));
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  let leaseStats;
  try {
    leaseStats = await lstat(leasePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (!leaseStats.isFile() || leaseStats.isSymbolicLink() || !isOwned(leaseStats)) {
    throw new Error("Recovery temporary-download lease is not a safe owned file");
  }
  if (await removeCandidateIfUnchanged(leasePath, leaseStats, false)) return;
  throw new Error("Recovery temporary-download lease changed before it could be removed safely");
}

export async function trackRecoveryTemporaryDownload(tempPath: string) {
  const pointsRoot = path.resolve(recoveryPointsRootDir());
  const resolved = path.resolve(tempPath);
  if (!isPathInside(pointsRoot, resolved)) return null;
  if (!isDownloadCandidateName(path.basename(resolved))) {
    throw new Error("Invalid recovery temporary download name");
  }
  await ensureSafeRecoveryParent(path.dirname(resolved));
  const leasePath = `${resolved}${RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX}`;
  await startRecoveryTemporaryLease(resolved, leasePath);
  let releasePromise: Promise<void> | null = null;
  return async () => {
    if (!releasePromise) {
      releasePromise = (async () => {
        stopRecoveryTemporaryLease(resolved);
        await removeRecoveryTemporaryDownloadLease(leasePath);
      })();
    }
    return releasePromise;
  };
}

async function readLeaseFreshness(candidateStats: Stats, leasePath: string) {
  try {
    const leaseStats = await lstat(leasePath);
    if (!leaseStats.isFile() || leaseStats.isSymbolicLink() || !isOwned(leaseStats)) {
      return { safe: false, mtimeMs: candidateStats.mtimeMs };
    }
    return {
      safe: true,
      mtimeMs: Math.max(candidateStats.mtimeMs, leaseStats.mtimeMs)
    };
  } catch (error) {
    if (isMissingFile(error)) return { safe: true, mtimeMs: candidateStats.mtimeMs };
    throw error;
  }
}

async function removeCandidateIfUnchanged(
  candidate: string,
  initialStats: Stats,
  recursive: boolean
) {
  let currentStats;
  try {
    currentStats = await lstat(candidate);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  if (
    currentStats.dev !== initialStats.dev
    || currentStats.ino !== initialStats.ino
    || currentStats.isSymbolicLink()
    || !isOwned(currentStats)
    || (recursive ? !currentStats.isDirectory() : !currentStats.isFile())
  ) {
    return false;
  }
  await rm(candidate, { recursive, force: true });
  return true;
}

export async function cleanupStaleRecoveryTemporaryResidue(options: {
  root?: string;
  maxAgeMs?: number;
  nowMs?: number;
} = {}) {
  const root = path.resolve(options.root ?? recoveryPointsRootDir());
  const maxAgeMs = options.maxAgeMs ?? RECOVERY_TEMPORARY_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) {
    throw new Error("Invalid recovery temporary cleanup age");
  }

  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (isMissingFile(error)) return { removed: 0, skipped: 0 };
    throw error;
  }
  assertOwnedDirectory(rootStats, "Recovery temporary cleanup root");

  let removed = 0;
  let skipped = 0;
  const protectedTemporaryAncestors = new Set<string>();
  const protectTemporaryAncestors = (candidate: string) => {
    let current = path.resolve(candidate);
    while (isPathInside(root, current)) {
      protectedTemporaryAncestors.add(current);
      current = path.dirname(current);
    }
  };

  const processDownloadCandidate = async (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!isPathInside(root, resolved) || activeRecoveryTemporaryPaths.has(resolved)) {
      protectTemporaryAncestors(resolved);
      skipped += 1;
      return;
    }
    let stats;
    try {
      stats = await lstat(resolved);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || !isOwned(stats)) {
      protectTemporaryAncestors(resolved);
      skipped += 1;
      return;
    }
    const leasePath = `${resolved}${RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX}`;
    const freshness = await readLeaseFreshness(stats, leasePath);
    if (!freshness.safe || nowMs - freshness.mtimeMs < maxAgeMs) {
      protectTemporaryAncestors(resolved);
      skipped += 1;
      return;
    }
    if (await removeCandidateIfUnchanged(resolved, stats, false)) {
      removed += 1;
      await rm(leasePath, { force: true }).catch((error) => {
        if (!isMissingFile(error)) throw error;
      });
    } else {
      protectTemporaryAncestors(resolved);
      skipped += 1;
    }
  };

  const processOrphanDownloadLease = async (leasePath: string) => {
    const candidate = leasePath.slice(0, -RECOVERY_TEMPORARY_DOWNLOAD_LEASE_SUFFIX.length);
    if (activeRecoveryTemporaryPaths.has(path.resolve(candidate))) {
      protectTemporaryAncestors(leasePath);
      skipped += 1;
      return;
    }
    try {
      await lstat(candidate);
      return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    let leaseStats;
    try {
      leaseStats = await lstat(leasePath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (!leaseStats.isFile() || leaseStats.isSymbolicLink() || !isOwned(leaseStats)) {
      protectTemporaryAncestors(leasePath);
      skipped += 1;
      return;
    }
    if (nowMs - leaseStats.mtimeMs < maxAgeMs) {
      protectTemporaryAncestors(leasePath);
      skipped += 1;
      return;
    }
    if (await removeCandidateIfUnchanged(leasePath, leaseStats, false)) removed += 1;
    else {
      protectTemporaryAncestors(leasePath);
      skipped += 1;
    }
  };

  const scanDownloads = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) {
      protectTemporaryAncestors(directory);
      skipped += 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (!isPathInside(root, candidate)) {
        skipped += 1;
        continue;
      }
      if (isDownloadCandidateName(entry.name)) {
        await processDownloadCandidate(candidate);
        continue;
      }
      if (isDownloadLeaseName(entry.name)) {
        await processOrphanDownloadLease(candidate);
        continue;
      }
      let stats;
      try {
        stats = await lstat(candidate);
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink() && isOwned(stats)) {
        await scanDownloads(candidate, depth + 1);
      } else if (stats.isDirectory() || stats.isSymbolicLink() || !isOwned(stats)) {
        protectTemporaryAncestors(candidate);
        skipped += 1;
      }
    }
  };

  const processNamespaceCandidate = async (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (
      !isPathInside(root, resolved)
      || activeRecoveryTemporaryPaths.has(resolved)
      || protectedTemporaryAncestors.has(resolved)
    ) {
      skipped += 1;
      return;
    }
    let stats;
    try {
      stats = await lstat(resolved);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    if (
      stats.isSymbolicLink()
      || !isOwned(stats)
      || (!stats.isDirectory() && !stats.isFile())
    ) {
      skipped += 1;
      return;
    }
    const leasePath = stats.isDirectory()
      ? path.join(resolved, RECOVERY_TEMPORARY_DIRECTORY_LEASE)
      : "";
    if (stats.isDirectory()) {
      try {
        const markerStats = await lstat(
          path.join(resolved, RECOVERY_RECONCILIATION_MARKER)
        );
        // Fail closed for both the expected marker and any unsafe replacement:
        // reconciliation evidence must only be removed deliberately.
        if (
          !markerStats.isFile()
          || markerStats.isSymbolicLink()
          || !isOwned(markerStats)
        ) {
          skipped += 1;
          return;
        }
        skipped += 1;
        return;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    const freshness = leasePath
      ? await readLeaseFreshness(stats, leasePath)
      : { safe: true, mtimeMs: stats.mtimeMs };
    if (!freshness.safe || nowMs - freshness.mtimeMs < maxAgeMs) {
      skipped += 1;
      return;
    }
    if (await removeCandidateIfUnchanged(resolved, stats, stats.isDirectory())) removed += 1;
    else skipped += 1;
  };

  const pointEntries = await readdir(root, { withFileTypes: true });
  for (const pointEntry of pointEntries) {
    if (!recoveryPointIdPattern.test(pointEntry.name)) continue;
    const pointPath = path.resolve(root, pointEntry.name);
    let pointStats;
    try {
      pointStats = await lstat(pointPath);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    if (!pointStats.isDirectory() || pointStats.isSymbolicLink() || !isOwned(pointStats)) {
      skipped += 1;
      continue;
    }

    await scanDownloads(pointPath, 0);
    for (const namespace of RECOVERY_TEMPORARY_NAMESPACES) {
      const namespacePath = path.resolve(pointPath, namespace);
      let namespaceStats;
      try {
        namespaceStats = await lstat(namespacePath);
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      if (
        !namespaceStats.isDirectory()
        || namespaceStats.isSymbolicLink()
        || !isOwned(namespaceStats)
      ) {
        skipped += 1;
        continue;
      }
      const entries = await readdir(namespacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === RECOVERY_TEMPORARY_DIRECTORY_LEASE
          || isDownloadCandidateName(entry.name)
          || isDownloadLeaseName(entry.name)
        ) {
          continue;
        }
        await processNamespaceCandidate(path.resolve(namespacePath, entry.name));
      }
    }
  }
  return { removed, skipped };
}
