import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareBackupStorage } from "./prepare-backup-storage.mjs";
import {
  DATABASE_TRANSITION,
  LEGACY_MANAGED_DATABASE_URL,
  reconcileManagedDatabase,
  restoreLegacyManagedDatabase
} from "./prepare-database-upgrade.mjs";

async function fixture() {
  return mkdtemp(path.join(os.tmpdir(), "composebastion-upgrade-preparation-"));
}

test("backup preparation recursively inspects nested paths and never follows symlinks", async () => {
  const directory = await fixture();
  const backupRoot = path.join(directory, "backups");
  const nested = path.join(backupRoot, "recovery", "nested");
  const external = path.join(directory, "outside.txt");
  const markerLink = path.join(backupRoot, ".composebastion-storage-owner");
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "archive.bin"), "archive\n");
    await writeFile(external, "do-not-overwrite\n");
    await symlink(external, markerLink);

    const first = await prepareBackupStorage({
      backupRoot,
      targetUid: process.getuid(),
      targetGid: process.getgid(),
      requireContainerRoot: false
    });
    const second = await prepareBackupStorage({
      backupRoot,
      targetUid: process.getuid(),
      targetGid: process.getgid(),
      requireContainerRoot: false
    });

    assert.equal(first.symlinksSkipped, 1);
    assert.equal(second.changed, 0);
    assert.equal(await readFile(external, "utf8"), "do-not-overwrite\n");
    assert.equal((await lstat(markerLink)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external database URLs produce a protected unchanged receipt without connecting", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  const victim = path.join(directory, "victim.txt");
  try {
    await chmod(directory, 0o700);
    await writeFile(victim, "preserve\n", { mode: 0o600 });
    await symlink(victim, stateFile);

    const result = await reconcileManagedDatabase({
      configuredUrl: "postgres://external:password@database.example:5432/app",
      postgresPassword: "unused-password",
      stateFile
    });

    assert.equal(result.changed, false);
    assert.equal((await lstat(stateFile)).isFile(), true);
    assert.equal((await lstat(stateFile)).mode & 0o777, 0o600);
    assert.equal(await readFile(victim, "utf8"), "preserve\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential restoration is a no-op for a valid unchanged receipt", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  try {
    await writeFile(stateFile, `${JSON.stringify({
      schema: 1,
      transition: DATABASE_TRANSITION,
      status: "unchanged",
      changed: false,
      reason: "managed-password-already-accepted"
    })}\n`, { mode: 0o600 });

    const result = await restoreLegacyManagedDatabase({
      configuredUrl: "postgres://composebastion:composebastion@postgres:5432/composebastion",
      postgresPassword: "managed-password",
      stateFile
    });
    assert.equal(result.changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external database rollback remains a verified no-op", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-db-external-rollback-"));
  const stateFile = path.join(directory, "transition.json");
  await writeFile(stateFile, `${JSON.stringify({
    schema: 1,
    transition: DATABASE_TRANSITION,
    status: "unchanged",
    changed: false,
    reason: "explicit-or-derived-database-url"
  })}\n`, { mode: 0o600 });
  const result = await restoreLegacyManagedDatabase({
    configuredUrl: "postgres://external.invalid/database",
    postgresPassword: "not-used",
    stateFile
  });
  assert.equal(result.changed, false);
  await rm(directory, { recursive: true, force: true });
});

test("credential restoration rejects an untrusted receipt before connecting", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  try {
    await writeFile(stateFile, `${JSON.stringify({
      schema: 1,
      transition: "untrusted-transition",
      status: "reconciled",
      changed: true
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      restoreLegacyManagedDatabase({
        configuredUrl: "postgres://composebastion:composebastion@postgres:5432/composebastion",
        postgresPassword: "managed-password",
        stateFile
      }),
      /valid transition receipt/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed credential reconciliation preserves rollback proof across retries", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  const postgresPassword = "replacement-password";
  let acceptedPassword = "composebastion";
  const acceptsConnection = async (url) => (
    url === LEGACY_MANAGED_DATABASE_URL
      ? acceptedPassword === "composebastion"
      : acceptedPassword === postgresPassword
  );
  const connectClient = async (url) => {
    if (!(await acceptsConnection(url))) throw new Error("authentication failed");
    return {
      async query(statement) {
        acceptedPassword = statement.includes("'composebastion'")
          ? "composebastion"
          : postgresPassword;
      },
      async end() {}
    };
  };
  try {
    const first = await reconcileManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection,
      connectClient
    });
    assert.equal(first.changed, true);
    assert.equal(first.status, "reconciled");
    assert.equal(acceptedPassword, postgresPassword);

    const retry = await reconcileManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection,
      connectClient
    });
    assert.equal(retry.changed, true);
    assert.equal(retry.status, "reconciled");

    const restored = await restoreLegacyManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection,
      connectClient
    });
    assert.equal(restored.status, "restored");
    assert.equal(acceptedPassword, "composebastion");

    const restoreRetry = await restoreLegacyManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection,
      connectClient
    });
    assert.equal(restoreRetry.status, "restored");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed credential reconciliation fails closed when neither credential works", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  try {
    await assert.rejects(
      reconcileManagedDatabase({
        configuredUrl: LEGACY_MANAGED_DATABASE_URL,
        postgresPassword: "replacement-password",
        stateFile,
        acceptsConnection: async () => false,
        connectClient: async () => { throw new Error("authentication failed"); }
      }),
      /accepts neither POSTGRES_PASSWORD nor the repository legacy credential/
    );
    await assert.rejects(readFile(stateFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
