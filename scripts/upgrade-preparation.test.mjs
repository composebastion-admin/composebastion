import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareBackupStorage } from "./prepare-backup-storage.mjs";
import {
  DATABASE_TRANSITION,
  LEGACY_MANAGED_DATABASE_URL,
  readRawEnvironmentProbe,
  reconcileManagedDatabase,
  restoreLegacyManagedDatabase
} from "./prepare-database-upgrade.mjs";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDirectory = await mkdtemp(path.join(os.tmpdir(), "composebastion-storage-helper-"));
const helperPath = path.join(helperDirectory, "composebastion-prepare-storage");
const execFileAsync = promisify(execFile);
execFileSync(process.env.CC || "cc", [
  "-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-DCOMPOSEBASTION_STORAGE_HELPER_TESTING",
  path.join(testRoot, "scripts", "prepare-backup-storage.c"),
  "-o", helperPath
]);
after(async () => rm(helperDirectory, { recursive: true, force: true }));

async function waitForFile(file) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

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
      requireContainerRoot: false,
      helperPath
    });
    const second = await prepareBackupStorage({
      backupRoot,
      targetUid: process.getuid(),
      targetGid: process.getgid(),
      requireContainerRoot: false,
      helperPath
    });

    assert.equal(first.symlinksSkipped, 1);
    assert.equal(second.changed, 0);
    assert.equal(await readFile(external, "utf8"), "do-not-overwrite\n");
    assert.equal((await lstat(markerLink)).isSymbolicLink(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup preparation does not follow an entry replaced by a symlink after inspection", async () => {
  const directory = await fixture();
  const backupRoot = path.join(directory, "backups");
  const candidate = path.join(backupRoot, "candidate");
  const external = path.join(directory, "outside.txt");
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  try {
    await mkdir(backupRoot);
    await writeFile(candidate, "replace me\n");
    await writeFile(external, "external remains unchanged\n");
    const running = execFileAsync(helperPath, [backupRoot, String(process.getuid()), String(process.getgid())], {
      env: {
        ...process.env,
        COMPOSEBASTION_STORAGE_TEST_PAUSE_ENTRY: "candidate",
        COMPOSEBASTION_STORAGE_TEST_READY_FILE: ready,
        COMPOSEBASTION_STORAGE_TEST_RELEASE_FILE: release
      }
    });
    await waitForFile(ready);
    await rm(candidate);
    await symlink(external, candidate);
    await writeFile(release, "continue\n");
    const result = JSON.parse((await running).stdout);

    assert.equal(result.symlinksSkipped, 1);
    assert.equal((await lstat(candidate)).isSymbolicLink(), true);
    assert.equal(await readFile(external, "utf8"), "external remains unchanged\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup preparation holds the parent descriptor when a directory is replaced", async () => {
  const directory = await fixture();
  const backupRoot = path.join(directory, "backups");
  const parent = path.join(backupRoot, "parent");
  const displaced = path.join(directory, "displaced-parent");
  const external = path.join(directory, "outside");
  const externalFile = path.join(external, "external.txt");
  const ready = path.join(directory, "parent-ready");
  const release = path.join(directory, "parent-release");
  try {
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, "inside.txt"), "inside\n");
    await mkdir(external);
    await writeFile(externalFile, "external remains unchanged\n");
    const running = execFileAsync(helperPath, [backupRoot, String(process.getuid()), String(process.getgid())], {
      env: {
        ...process.env,
        COMPOSEBASTION_STORAGE_TEST_PAUSE_ENTRY: "parent",
        COMPOSEBASTION_STORAGE_TEST_READY_FILE: ready,
        COMPOSEBASTION_STORAGE_TEST_RELEASE_FILE: release
      }
    });
    await waitForFile(ready);
    await rename(parent, displaced);
    await symlink(external, parent);
    await writeFile(release, "continue\n");
    const result = JSON.parse((await running).stdout);

    assert.equal(result.symlinksSkipped, 1);
    assert.equal((await lstat(parent)).isSymbolicLink(), true);
    assert.equal(await readFile(externalFile, "utf8"), "external remains unchanged\n");
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

    assert.equal(result.credentialTransition, "unchanged");
    assert.equal(result.environmentAction, "preserve");
    assert.equal(result.receipt.changed, false);
    assert.equal((await lstat(stateFile)).isFile(), true);
    assert.equal((await lstat(stateFile)).mode & 0o777, 0o600);
    assert.equal(await readFile(victim, "utf8"), "preserve\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external and custom database URLs bypass irrelevant managed-password validation", async (t) => {
  const cases = [
    {
      name: "effective external URL",
      configuredUrl: "postgres://external:password@database.example:5432/app",
      rawEnvironmentUrl: null
    },
    {
      name: "raw custom URL overriding a legacy effective URL",
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      rawEnvironmentUrl: "postgres://external:password@database.example:5432/app"
    },
    {
      name: "stale raw legacy assignment with an external effective URL",
      configuredUrl: "postgres://external:password@database.example:5432/app",
      rawEnvironmentUrl: LEGACY_MANAGED_DATABASE_URL
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const directory = await fixture();
      const stateFile = path.join(directory, "database-transition.json");
      let connectionChecks = 0;
      let rotations = 0;
      try {
        const result = await reconcileManagedDatabase({
          ...scenario,
          postgresPassword: "invalid password",
          stateFile,
          acceptsConnection: async () => { connectionChecks += 1; return false; },
          connectClient: async () => { rotations += 1; throw new Error("must not connect"); }
        });

        assert.equal(result.credentialTransition, "unchanged");
        assert.equal(result.environmentAction, "preserve");
        assert.equal(result.receipt.changed, false);
        assert.equal(connectionChecks, 0);
        assert.equal(rotations, 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("invalid managed passwords still fail closed for managed effective URLs", async (t) => {
  for (const configuredUrl of [
    LEGACY_MANAGED_DATABASE_URL,
    "postgres://composebastion:invalid password@postgres:5432/composebastion"
  ]) {
    await t.test(configuredUrl === LEGACY_MANAGED_DATABASE_URL ? "legacy" : "canonical-shaped", async () => {
      await assert.rejects(
        reconcileManagedDatabase({
          configuredUrl,
          rawEnvironmentUrl: null,
          postgresPassword: "invalid password",
          acceptsConnection: async () => { throw new Error("must not connect"); },
          connectClient: async () => { throw new Error("must not connect"); }
        }),
        /POSTGRES_PASSWORD must be non-empty and URL-safe/
      );
    });
  }
});

test("protected raw environment probes preserve the exact ignored assignment", async () => {
  const directory = await fixture();
  const probe = path.join(directory, "raw-environment.json");
  try {
    await writeFile(probe, `${JSON.stringify({
      services: {
        "composebastion-upgrade-probe": {
          environment: { COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: LEGACY_MANAGED_DATABASE_URL }
        }
      }
    })}\n`, { mode: 0o600 });
    assert.equal(await readRawEnvironmentProbe(probe), LEGACY_MANAGED_DATABASE_URL);
    await chmod(probe, 0o644);
    await assert.rejects(readRawEnvironmentProbe(probe), /mode-0600 regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale raw legacy assignment is canonicalized without claiming a credential rotation", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  const postgresPassword = "managed-password";
  try {
    const result = await reconcileManagedDatabase({
      configuredUrl: `postgres://composebastion:${postgresPassword}@postgres:5432/composebastion`,
      rawEnvironmentUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection: async (url) => url.includes(`:${postgresPassword}@`),
      connectClient: async () => { throw new Error("must not rotate"); }
    });

    assert.equal(result.credentialTransition, "unchanged");
    assert.equal(result.environmentAction, "canonicalize");
    assert.equal(result.receipt.reason, "managed-password-already-accepted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a matching canonical environment preserves changed-state rollback authority", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  const postgresPassword = "managed-password";
  const canonicalUrl = `postgres://composebastion:${postgresPassword}@postgres:5432/composebastion`;
  try {
    await writeFile(stateFile, `${JSON.stringify({
      schema: 1,
      transition: DATABASE_TRANSITION,
      status: "reconciled",
      changed: true,
      reason: "legacy-password-rotated"
    })}\n`, { mode: 0o600 });

    const result = await reconcileManagedDatabase({
      configuredUrl: canonicalUrl,
      rawEnvironmentUrl: canonicalUrl,
      postgresPassword,
      stateFile,
      acceptsConnection: async (url) => url === canonicalUrl,
      connectClient: async () => { throw new Error("must not rotate"); }
    });

    assert.equal(result.credentialTransition, "changed");
    assert.equal(result.environmentAction, "preserve");
    assert.equal(result.receipt.status, "reconciled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom raw database URLs remain unchanged and discard rollback authority", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  try {
    await writeFile(stateFile, `${JSON.stringify({
      schema: 1,
      transition: DATABASE_TRANSITION,
      status: "reconciled",
      changed: true,
      reason: "legacy-password-rotated"
    })}\n`, { mode: 0o600 });
    let connectionChecks = 0;
    const result = await reconcileManagedDatabase({
      configuredUrl: "postgres://external:password@database.example:5432/app",
      rawEnvironmentUrl: "postgres://external:password@database.example:5432/app",
      postgresPassword: "managed-password",
      stateFile,
      acceptsConnection: async () => { connectionChecks += 1; return true; },
      connectClient: async () => { throw new Error("must not connect"); }
    });

    assert.equal(connectionChecks, 0);
    assert.equal(result.credentialTransition, "unchanged");
    assert.equal(result.environmentAction, "preserve");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).changed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a custom raw URL never grants rotation authority through an ignored legacy effective URL", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  let connectionChecks = 0;
  try {
    const result = await reconcileManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      rawEnvironmentUrl: "postgres://external:password@database.example:5432/app",
      postgresPassword: "managed-password",
      stateFile,
      acceptsConnection: async () => { connectionChecks += 1; return true; },
      connectClient: async () => { throw new Error("must not connect"); }
    });

    assert.equal(connectionChecks, 0);
    assert.equal(result.credentialTransition, "unchanged");
    assert.equal(result.environmentAction, "preserve");
    assert.equal(result.receipt.changed, false);
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
    assert.equal(first.credentialTransition, "changed");
    assert.equal(first.environmentAction, "canonicalize");
    assert.equal(first.receipt.status, "reconciled");
    assert.equal(acceptedPassword, postgresPassword);

    const retry = await reconcileManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword,
      stateFile,
      acceptsConnection,
      connectClient
    });
    assert.equal(retry.credentialTransition, "changed");
    assert.equal(retry.receipt.status, "reconciled");

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

test("receipt publication syncs the parent directory before PostgreSQL commit", async () => {
  const directory = await fixture();
  const stateFile = path.join(directory, "database-transition.json");
  const events = [];
  let canonicalAccepted = false;
  const receiptFilesystem = {
    async open(file) {
      if (file === directory) {
        return {
          async sync() { events.push("parent-sync"); },
          async close() {}
        };
      }
      return {
        async writeFile() { events.push("receipt-write"); },
        async sync() { events.push("receipt-sync"); },
        async close() {}
      };
    },
    async rename() { events.push("receipt-rename"); },
    async chmod() { events.push("receipt-chmod"); },
    async rm() {}
  };
  try {
    await reconcileManagedDatabase({
      configuredUrl: LEGACY_MANAGED_DATABASE_URL,
      rawEnvironmentUrl: LEGACY_MANAGED_DATABASE_URL,
      postgresPassword: "replacement-password",
      stateFile,
      acceptsConnection: async (url) => (
        url === LEGACY_MANAGED_DATABASE_URL || canonicalAccepted
      ),
      connectClient: async () => ({
        async query(statement) {
          events.push(statement);
          if (statement === "COMMIT") canonicalAccepted = true;
        },
        async end() {}
      }),
      receiptFilesystem
    });

    const commitIndex = events.indexOf("COMMIT");
    const receiptSyncIndex = events.lastIndexOf("receipt-sync", commitIndex);
    const receiptRenameIndex = events.lastIndexOf("receipt-rename", commitIndex);
    const parentSyncIndex = events.lastIndexOf("parent-sync", commitIndex);
    assert.ok(commitIndex > 0);
    assert.ok(receiptSyncIndex >= 0 && receiptSyncIndex < receiptRenameIndex);
    assert.ok(receiptRenameIndex < parentSyncIndex);
    assert.ok(parentSyncIndex < commitIndex);
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
