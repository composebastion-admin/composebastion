import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareBackupStorage, numericIdentity } from "./prepare-backup-storage.mjs";
import {
  reconcileManagedDatabase,
  restoreLegacyManagedDatabase
} from "./prepare-database-upgrade.mjs";

async function readProtectedComposeConfig(configPath) {
  let handle;
  try {
    handle = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error("Rendered Compose configuration must be a mode-0600 regular file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Rendered Compose configuration is invalid JSON");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function serviceEnvironment(config, serviceName) {
  const environment = config?.services?.[serviceName]?.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error(`Rendered Compose configuration is missing ${serviceName} environment`);
  }
  return environment;
}

function runtimeIdentity(config) {
  const configured = config?.services?.app?.user;
  if (configured === undefined || configured === null || configured === "") {
    return { uid: 1000, gid: 1000 };
  }
  const match = /^(\d+):(\d+)$/.exec(String(configured));
  if (!match) {
    throw new Error("Rendered app user must be an explicit numeric UID:GID pair");
  }
  return {
    uid: numericIdentity("app UID", match[1]),
    gid: numericIdentity("app GID", match[2])
  };
}

function managedDatabaseConfiguration(config) {
  const appEnvironment = serviceEnvironment(config, "app");
  const workerEnvironment = serviceEnvironment(config, "worker");
  const postgresEnvironment = serviceEnvironment(config, "postgres");
  const configuredUrl = String(appEnvironment.DATABASE_URL ?? "");
  if (!configuredUrl || configuredUrl !== String(workerEnvironment.DATABASE_URL ?? "")) {
    throw new Error("Rendered app and worker DATABASE_URL values must match");
  }
  const postgresPassword = String(postgresEnvironment.POSTGRES_PASSWORD ?? "");
  if (!postgresPassword) throw new Error("Rendered PostgreSQL service is missing POSTGRES_PASSWORD");
  return { configuredUrl, postgresPassword };
}

function parseCli(argv) {
  const args = [...argv];
  const mode = args.shift();
  let composeConfig = null;
  let stateFile = null;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--compose-config") composeConfig = args.shift() || null;
    else if (argument === "--state-file") stateFile = args.shift() || null;
    else throw new Error(`Unknown Compose upgrade argument: ${argument}`);
  }
  if (!["reconcile", "restore-legacy"].includes(mode)) {
    throw new Error("Compose upgrade mode must be reconcile or restore-legacy");
  }
  if (!composeConfig || !stateFile) {
    throw new Error("Compose upgrade requires --compose-config and --state-file");
  }
  return { mode, composeConfig, stateFile };
}

export async function runComposeUpgrade({ mode, composeConfig, stateFile }) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("Compose upgrade preparation must run as container root");
  }
  const config = await readProtectedComposeConfig(composeConfig);
  const database = managedDatabaseConfiguration(config);

  if (mode === "restore-legacy") {
    return restoreLegacyManagedDatabase({ ...database, stateFile });
  }

  const identity = runtimeIdentity(config);
  const storage = await prepareBackupStorage({
    targetUid: identity.uid,
    targetGid: identity.gid
  });
  const credential = await reconcileManagedDatabase({ ...database, stateFile });
  console.info(
    `Compose upgrade preparation completed for ${identity.uid}:${identity.gid}; `
    + `storage changes ${storage.changed}, credential state ${credential.status}.`
  );
  return { storage, credential };
}

async function main() {
  await runComposeUpgrade(parseCli(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
