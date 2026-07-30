import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const pointId = "00000000-0000-4000-8000-000000000101";
const secondPointId = "00000000-0000-4000-8000-000000000102";
const cleanupRoots: string[] = [];

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

async function importStorage(backupRoot: string) {
  vi.resetModules();
  vi.stubEnv("BACKUP_DIR", backupRoot);
  return import("../src/services/recoveryTemporaryStorage.js");
}

describe("recovery temporary storage cleanup", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanupRoots.splice(0).map((root) => (
      rm(root, { recursive: true, force: true })
    )));
  });

  it("removes stale recovery residues while preserving fresh leases, unrelated files, and symlink targets", async () => {
    const backupRoot = await temporaryRoot("composebastion-recovery-cleanup-");
    const outside = await temporaryRoot("composebastion-recovery-outside-");
    const pointsRoot = path.join(backupRoot, "recovery-points");
    const pointRoot = path.join(pointsRoot, pointId);
    const hydratedRoot = path.join(pointRoot, ".hydrated");
    const remoteVerifyRoot = path.join(pointRoot, ".remote-verify");
    const remoteVerificationRoot = path.join(pointRoot, ".remote-verification");
    const volumeRoot = path.join(pointRoot, "volumes");
    await Promise.all([
      mkdir(hydratedRoot, { recursive: true }),
      mkdir(remoteVerifyRoot, { recursive: true }),
      mkdir(remoteVerificationRoot, { recursive: true }),
      mkdir(volumeRoot, { recursive: true })
    ]);

    const staleHydrated = path.join(hydratedRoot, "legacy-hydrated-artifact");
    const staleRemoteVerify = path.join(remoteVerifyRoot, "artifact-stale");
    const downloadProtectedRemoteVerify = path.join(remoteVerifyRoot, "artifact-downloading");
    const nestedActiveDownload = path.join(
      downloadProtectedRemoteVerify,
      ".download-artifact-active.tmp"
    );
    const nestedActiveDownloadLease = `${nestedActiveDownload}.composebastion-active`;
    const activeRemoteVerification = path.join(remoteVerificationRoot, "artifact-active");
    const recentRemoteVerification = path.join(remoteVerificationRoot, "artifact-recent");
    const linkedHydrated = path.join(hydratedRoot, "linked-artifact");
    const staleDownload = path.join(volumeRoot, ".download-data.tar.gz-stale.tmp");
    const staleDownloadLease = `${staleDownload}.composebastion-active`;
    const activeDownload = path.join(volumeRoot, ".download-data.tar.gz-active.tmp");
    const activeDownloadLease = `${activeDownload}.composebastion-active`;
    const linkedDownload = path.join(volumeRoot, ".download-linked.tmp");
    const orphanLease = path.join(volumeRoot, ".download-orphan.tmp.composebastion-active");
    const unrelated = path.join(volumeRoot, "data.tar.gz");
    const outsideMarker = path.join(outside, "keep");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 60 * 60_000);

    await Promise.all([
      writeFile(staleHydrated, "stale hydration"),
      mkdir(staleRemoteVerify),
      mkdir(downloadProtectedRemoteVerify),
      mkdir(activeRemoteVerification),
      mkdir(recentRemoteVerification),
      writeFile(staleDownload, "stale download"),
      writeFile(staleDownloadLease, "stopped\n", { mode: 0o600 }),
      writeFile(activeDownload, "active download"),
      writeFile(activeDownloadLease, "other-worker\n", { mode: 0o600 }),
      writeFile(nestedActiveDownload, "nested active download"),
      writeFile(nestedActiveDownloadLease, "other-worker\n", { mode: 0o600 }),
      writeFile(orphanLease, "stopped\n", { mode: 0o600 }),
      writeFile(unrelated, "retained artifact"),
      writeFile(outsideMarker, "outside")
    ]);
    await Promise.all([
      writeFile(path.join(staleRemoteVerify, ".composebastion-active"), "stopped\n", { mode: 0o600 }),
      writeFile(path.join(activeRemoteVerification, ".composebastion-active"), "other-worker\n", { mode: 0o600 }),
      symlink(outsideMarker, linkedHydrated),
      symlink(outsideMarker, linkedDownload),
      symlink(outside, path.join(pointsRoot, secondPointId))
    ]);
    await Promise.all([
      utimes(staleHydrated, staleDate, staleDate),
      utimes(staleRemoteVerify, staleDate, staleDate),
      utimes(path.join(staleRemoteVerify, ".composebastion-active"), staleDate, staleDate),
      utimes(downloadProtectedRemoteVerify, staleDate, staleDate),
      utimes(nestedActiveDownload, staleDate, staleDate),
      utimes(activeRemoteVerification, staleDate, staleDate),
      utimes(staleDownload, staleDate, staleDate),
      utimes(staleDownloadLease, staleDate, staleDate),
      utimes(activeDownload, staleDate, staleDate),
      utimes(orphanLease, staleDate, staleDate)
    ]);

    const { cleanupStaleRecoveryTemporaryResidue } = await importStorage(backupRoot);
    const result = await cleanupStaleRecoveryTemporaryResidue({
      root: pointsRoot,
      maxAgeMs: 15 * 60_000,
      nowMs
    });

    expect(result.removed).toBe(4);
    expect(result.skipped).toBeGreaterThanOrEqual(6);
    await expect(lstat(staleHydrated)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staleRemoteVerify)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staleDownload)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staleDownloadLease)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(orphanLease)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(activeDownload, "utf8")).resolves.toBe("active download");
    await expect(readFile(activeDownloadLease, "utf8")).resolves.toBe("other-worker\n");
    await expect(readFile(nestedActiveDownload, "utf8")).resolves.toBe("nested active download");
    await expect(readFile(nestedActiveDownloadLease, "utf8")).resolves.toBe("other-worker\n");
    await expect(lstat(activeRemoteVerification)).resolves.toMatchObject({});
    await expect(lstat(recentRemoteVerification)).resolves.toMatchObject({});
    await expect(readFile(unrelated, "utf8")).resolves.toBe("retained artifact");
    await expect(readFile(outsideMarker, "utf8")).resolves.toBe("outside");
  });

  it("protects in-process leased directories and downloads until their leases are released", async () => {
    const backupRoot = await temporaryRoot("composebastion-recovery-active-");
    const storage = await importStorage(backupRoot);
    const directory = await storage.createRecoveryTemporaryDirectory(
      pointId,
      ".hydrated",
      "artifact"
    );
    await writeFile(path.join(directory, "artifact"), "active");
    const tempDownload = path.join(
      backupRoot,
      "recovery-points",
      pointId,
      "volumes",
      ".download-data.tar.gz-active.tmp"
    );
    const releaseDownload = await storage.trackRecoveryTemporaryDownload(tempDownload);
    expect(releaseDownload).not.toBeNull();
    await writeFile(tempDownload, "active download");

    const activeResult = await storage.cleanupStaleRecoveryTemporaryResidue({
      maxAgeMs: 0,
      nowMs: Date.now()
    });
    expect(activeResult.removed).toBe(0);
    await expect(readFile(path.join(directory, "artifact"), "utf8")).resolves.toBe("active");
    await expect(readFile(tempDownload, "utf8")).resolves.toBe("active download");

    await releaseDownload!();
    await storage.removeTrackedRecoveryTemporaryDirectory(directory);
    const releasedResult = await storage.cleanupStaleRecoveryTemporaryResidue({
      maxAgeMs: 0,
      nowMs: Date.now()
    });
    expect(releasedResult.removed).toBe(1);
    await expect(lstat(tempDownload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a private exact-locator reconciliation marker that stale cleanup cannot remove", async () => {
    const backupRoot = await temporaryRoot("composebastion-recovery-reconcile-");
    const storage = await importStorage(backupRoot);
    const directory = await storage.createRecoveryTemporaryDirectory(
      pointId,
      ".capture",
      "attempt-token"
    );
    const artifactPath = path.join(directory, "manifest.json");
    await writeFile(artifactPath, "capture evidence", { mode: 0o600 });
    const evidence = {
      recoveryPointId: pointId,
      artifactId: "00000000-0000-4000-8000-000000000103",
      attemptToken: "attempt-token",
      storageKey: "manifest.json",
      remoteObjectKey: `${pointId}/attempts/attempt-token/manifest.json`,
      remoteBackend: "s3",
      backupTargetId: "00000000-0000-4000-8000-000000000104"
    };

    await storage.preserveTrackedRecoveryTemporaryDirectory(directory, evidence);
    // Repeated preservation is idempotent and cannot replace the original
    // attempt evidence with a later worker's values.
    await storage.preserveTrackedRecoveryTemporaryDirectory(directory, {
      ...evidence,
      attemptToken: "successor-token"
    });

    const markerPath = path.join(directory, storage.RECOVERY_RECONCILIATION_MARKER);
    const markerStats = await lstat(markerPath);
    expect(markerStats.mode & 0o777).toBe(0o600);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker).toMatchObject({
      reason: "capture_commit_outcome_unknown",
      ...evidence,
      recordedAt: expect.any(String)
    });
    expect(JSON.stringify(marker)).not.toContain("credential");

    const cleanup = await storage.cleanupStaleRecoveryTemporaryResidue({
      maxAgeMs: 0,
      nowMs: Date.now() + 60_000
    });
    expect(cleanup.removed).toBe(0);
    expect(cleanup.skipped).toBeGreaterThanOrEqual(1);
    await expect(readFile(artifactPath, "utf8")).resolves.toBe("capture evidence");
  });

  it("rejects symlinked temporary namespaces and download parents without touching their targets", async () => {
    const backupRoot = await temporaryRoot("composebastion-recovery-symlink-");
    const outside = await temporaryRoot("composebastion-recovery-symlink-outside-");
    const pointRoot = path.join(backupRoot, "recovery-points", pointId);
    const secondPointRoot = path.join(backupRoot, "recovery-points", secondPointId);
    await Promise.all([
      mkdir(pointRoot, { recursive: true }),
      mkdir(secondPointRoot, { recursive: true })
    ]);
    const outsideMarker = path.join(outside, "keep");
    await writeFile(outsideMarker, "outside");
    await Promise.all([
      symlink(outside, path.join(pointRoot, ".hydrated")),
      symlink(outside, path.join(secondPointRoot, "volumes"))
    ]);

    const storage = await importStorage(backupRoot);
    await expect(storage.createRecoveryTemporaryDirectory(
      pointId,
      ".hydrated",
      "artifact"
    )).rejects.toThrow("not a safe owned directory");
    await expect(storage.trackRecoveryTemporaryDownload(path.join(
      secondPointRoot,
      "volumes",
      ".download-data.tar.gz-test.tmp"
    ))).rejects.toThrow("not a safe owned directory");

    await rm(path.join(pointRoot, ".hydrated"));
    const trackedDirectory = await storage.createRecoveryTemporaryDirectory(
      pointId,
      ".hydrated",
      "artifact"
    );
    const trackedNamespace = path.dirname(trackedDirectory);
    const parkedNamespace = `${trackedNamespace}.parked`;
    await rename(trackedNamespace, parkedNamespace);
    const outsideTrackedDirectory = path.join(outside, path.basename(trackedDirectory));
    const outsideTrackedMarker = path.join(outsideTrackedDirectory, "keep");
    await mkdir(outsideTrackedDirectory);
    await writeFile(outsideTrackedMarker, "outside tracked directory");
    await symlink(outside, trackedNamespace);

    await expect(storage.removeTrackedRecoveryTemporaryDirectory(trackedDirectory))
      .rejects.toThrow("not a safe owned directory");
    await expect(readFile(outsideTrackedMarker, "utf8")).resolves.toBe("outside tracked directory");
    await expect(storage.removeTrackedRecoveryTemporaryDirectory(pointRoot))
      .rejects.toThrow("not a recovery temporary directory");

    await rm(trackedNamespace);
    await rename(parkedNamespace, trackedNamespace);
    await storage.removeTrackedRecoveryTemporaryDirectory(trackedDirectory);
    await expect(readFile(outsideMarker, "utf8")).resolves.toBe("outside");
  });

  it("tolerates a missing root and rejects a symlinked cleanup root", async () => {
    const backupRoot = await temporaryRoot("composebastion-recovery-root-");
    const outside = await temporaryRoot("composebastion-recovery-root-outside-");
    const storage = await importStorage(backupRoot);
    const missingRoot = path.join(backupRoot, "missing-recovery-points");
    await expect(storage.cleanupStaleRecoveryTemporaryResidue({ root: missingRoot }))
      .resolves.toEqual({ removed: 0, skipped: 0 });

    const linkedRoot = path.join(backupRoot, "linked-recovery-points");
    await symlink(outside, linkedRoot);
    await expect(storage.cleanupStaleRecoveryTemporaryResidue({ root: linkedRoot }))
      .rejects.toThrow("not a safe owned directory");
  });
});
