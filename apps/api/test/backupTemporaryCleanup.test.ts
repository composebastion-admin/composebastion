import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupStaleBackupTemporaryDirectories } from "../src/services/backups.js";

const cleanupRoots: string[] = [];

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

describe("backup temporary-directory cleanup", () => {
  afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => (
      rm(root, { recursive: true, force: true })
    )));
  });

  it("removes only stale owned allowlisted directories and honors a cross-process heartbeat lease", async () => {
    const root = await temporaryRoot("composebastion-backup-cleanup-");
    const outside = await temporaryRoot("composebastion-backup-outside-");
    const staleVerify = path.join(root, ".composebastion-verify-stale01");
    const staleRemoteVerify = path.join(root, ".composebastion-remote-verify-stale02");
    const staleHydrate = path.join(root, ".composebastion-hydrate-stale03");
    const activeHydrate = path.join(root, ".composebastion-hydrate-active01");
    const recentVerify = path.join(root, ".composebastion-verify-recent01");
    const linked = path.join(root, ".composebastion-hydrate-linked01");
    const regularFile = path.join(root, ".composebastion-verify-file01");
    const unrelated = path.join(root, "prefix-.composebastion-verify-stale04");
    const nowMs = Date.now();
    const staleDate = new Date(nowMs - 60 * 60_000);

    await Promise.all([
      mkdir(staleVerify),
      mkdir(staleRemoteVerify),
      mkdir(staleHydrate),
      mkdir(activeHydrate),
      mkdir(recentVerify),
      mkdir(unrelated)
    ]);
    await Promise.all([
      writeFile(path.join(staleRemoteVerify, ".composebastion-active"), "stopped\n", { mode: 0o600 }),
      writeFile(path.join(staleHydrate, ".composebastion-active"), "stopped\n", { mode: 0o600 }),
      writeFile(path.join(activeHydrate, ".composebastion-active"), "other-process\n", { mode: 0o600 }),
      writeFile(path.join(outside, "keep"), "outside"),
      writeFile(regularFile, "not a directory"),
      symlink(outside, linked)
    ]);
    await Promise.all([
      utimes(staleVerify, staleDate, staleDate),
      utimes(staleRemoteVerify, staleDate, staleDate),
      utimes(path.join(staleRemoteVerify, ".composebastion-active"), staleDate, staleDate),
      utimes(staleHydrate, staleDate, staleDate),
      utimes(path.join(staleHydrate, ".composebastion-active"), staleDate, staleDate),
      // The directory itself is older than the stale threshold, but another
      // process's fresh lease proves that the long-running hydration is active.
      utimes(activeHydrate, staleDate, staleDate)
    ]);

    const result = await cleanupStaleBackupTemporaryDirectories({
      root,
      maxAgeMs: 15 * 60_000,
      nowMs
    });

    expect(result).toEqual({ removed: 3, skipped: 4 });
    await expect(readFile(path.join(staleVerify, "missing"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(staleRemoteVerify, ".composebastion-active"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(staleHydrate, ".composebastion-active"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(activeHydrate, ".composebastion-active"), "utf8"))
      .resolves.toBe("other-process\n");
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe("outside");
    await expect(readFile(regularFile, "utf8")).resolves.toBe("not a directory");
    await expect(readFile(path.join(unrelated, "missing"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tolerates a backup directory that no longer exists", async () => {
    const root = path.join(
      os.tmpdir(),
      `composebastion-backup-cleanup-missing-${process.pid}-${Date.now()}`
    );

    await expect(cleanupStaleBackupTemporaryDirectories({ root }))
      .resolves.toEqual({ removed: 0, skipped: 0 });
  });
});
