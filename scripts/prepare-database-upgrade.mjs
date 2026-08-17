import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const LEGACY_MANAGED_DATABASE_URL = "postgres://composebastion:composebastion@postgres:5432/composebastion";
export const DATABASE_TRANSITION = "legacy-managed-database-credential";

function validateManagedPassword(value) {
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new Error("POSTGRES_PASSWORD must be non-empty and URL-safe for managed database reconciliation");
  }
  return value;
}

function managedUrl(postgresPassword) {
  return `postgres://composebastion:${postgresPassword}@postgres:5432/composebastion`;
}

function isRepositoryManagedUrl(value) {
  return value === LEGACY_MANAGED_DATABASE_URL
    || (typeof value === "string"
      && value.startsWith("postgres://composebastion:")
      && value.endsWith("@postgres:5432/composebastion"));
}

async function connect(connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
}

async function accepts(connectionString) {
  let client;
  try {
    client = await connect(connectionString);
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

async function ensureStateParent(stateFile) {
  const parent = path.dirname(stateFile);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stats = await lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Database transition state parent must be a real directory");
  }
  return parent;
}

const defaultReceiptFilesystem = {
  chmod,
  open,
  rename,
  rm
};

async function writeReceipt(stateFile, receipt, filesystem = defaultReceiptFilesystem) {
  if (!stateFile) return;
  const parent = await ensureStateParent(stateFile);
  const temporary = path.join(parent, `.${path.basename(stateFile)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let parentHandle;
  try {
    handle = await filesystem.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await filesystem.rename(temporary, stateFile);
    await filesystem.chmod(stateFile, 0o600);
    parentHandle = await filesystem.open(
      parent,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    await parentHandle.sync();
    await parentHandle.close();
    parentHandle = null;
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
    await filesystem.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readReceipt(stateFile) {
  if (!stateFile) throw new Error("Credential restoration requires a transition state file");
  let handle;
  try {
    handle = await open(stateFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
      throw new Error("Database transition state must be a mode-0600 regular file");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Database transition state is invalid JSON");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readReceiptIfPresent(stateFile) {
  if (!stateFile) return null;
  try {
    return await readReceipt(stateFile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readRawEnvironmentProbe(probeFile) {
  if (!probeFile) return null;
  let handle;
  try {
    handle = await open(probeFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error("Raw environment probe must be a mode-0600 regular file");
    }
    const config = JSON.parse(await handle.readFile("utf8"));
    const environment = config?.services?.["composebastion-upgrade-probe"]?.environment;
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      throw new Error("Raw environment probe is missing its protected service environment");
    }
    return environment.COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL === undefined
      ? null
      : String(environment.COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Raw environment probe is invalid JSON");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isChangedTransitionReceipt(value) {
  return value?.schema === 1
    && value?.transition === DATABASE_TRANSITION
    && value?.changed === true
    && ["pending", "reconciled"].includes(value?.status);
}

function isRecognizedTransitionReceipt(value) {
  return value?.schema === 1
    && value?.transition === DATABASE_TRANSITION
    && (
      (value?.changed === false && value?.status === "unchanged")
      || (value?.changed === true && ["pending", "reconciled", "restored"].includes(value?.status))
    );
}

function receipt(status, changed, reason) {
  return {
    schema: 1,
    transition: DATABASE_TRANSITION,
    status,
    changed,
    reason
  };
}

function reconciliationResult(transitionReceipt, environmentAction) {
  return {
    credentialTransition: transitionReceipt.changed ? "changed" : "unchanged",
    environmentAction,
    receipt: transitionReceipt
  };
}

function environmentActionFor({ configuredUrl, rawEnvironmentUrl }) {
  if (rawEnvironmentUrl === LEGACY_MANAGED_DATABASE_URL) return "canonicalize";
  if (rawEnvironmentUrl && rawEnvironmentUrl !== LEGACY_MANAGED_DATABASE_URL) return "preserve";
  return configuredUrl === LEGACY_MANAGED_DATABASE_URL ? "canonicalize" : "preserve";
}

export async function reconcileManagedDatabase({
  configuredUrl = process.env.DATABASE_URL,
  rawEnvironmentUrl = Object.hasOwn(process.env, "COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL")
    ? process.env.COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL
    : null,
  postgresPassword = process.env.POSTGRES_PASSWORD || "",
  stateFile = null,
  acceptsConnection = accepts,
  connectClient = connect,
  receiptFilesystem = defaultReceiptFilesystem
} = {}) {
  const environmentAction = environmentActionFor({ configuredUrl, rawEnvironmentUrl });
  const rawUrlIsExplicitCustom = Boolean(rawEnvironmentUrl && !isRepositoryManagedUrl(rawEnvironmentUrl));
  const effectiveUrlLooksManaged = isRepositoryManagedUrl(configuredUrl);

  // The raw operator assignment is authoritative. Classify custom/external
  // deployments before validating a password that those deployments do not use.
  if (rawUrlIsExplicitCustom || (!effectiveUrlLooksManaged && rawEnvironmentUrl !== LEGACY_MANAGED_DATABASE_URL)) {
    const transitionReceipt = receipt("unchanged", false, "explicit-or-derived-database-url");
    await writeReceipt(stateFile, transitionReceipt, receiptFilesystem);
    console.info("Managed database credentials do not require legacy reconciliation.");
    return reconciliationResult(transitionReceipt, "preserve");
  }

  let password;
  try {
    password = validateManagedPassword(postgresPassword);
  } catch (error) {
    // A stale raw legacy assignment can be ignored by an external effective URL.
    // Without a valid managed password, it cannot be verified and canonicalized,
    // but it must not make the external deployment fail.
    if (!effectiveUrlLooksManaged && rawEnvironmentUrl === LEGACY_MANAGED_DATABASE_URL) {
      const transitionReceipt = receipt("unchanged", false, "external-url-with-unverifiable-stale-legacy-assignment");
      await writeReceipt(stateFile, transitionReceipt, receiptFilesystem);
      console.info("Preserved an unverifiable stale legacy assignment for an external database deployment.");
      return reconciliationResult(transitionReceipt, "preserve");
    }
    throw error;
  }

  const canonicalUrl = managedUrl(password);
  const rawUrlIsCustom = Boolean(
    rawEnvironmentUrl
    && rawEnvironmentUrl !== LEGACY_MANAGED_DATABASE_URL
    && rawEnvironmentUrl !== canonicalUrl
  );
  const isManagedEffectiveUrl = configuredUrl === LEGACY_MANAGED_DATABASE_URL
    || configuredUrl === canonicalUrl;
  const mayUseManagedCredential = isManagedEffectiveUrl && !rawUrlIsCustom;
  const canonicalAccepted = mayUseManagedCredential || environmentAction === "canonicalize"
    ? await acceptsConnection(canonicalUrl)
    : false;

  if (!mayUseManagedCredential) {
    const transitionReceipt = receipt("unchanged", false, "explicit-or-derived-database-url");
    await writeReceipt(stateFile, transitionReceipt, receiptFilesystem);
    console.info("Managed database credentials do not require legacy reconciliation.");
    return reconciliationResult(
      transitionReceipt,
      environmentAction === "canonicalize" && canonicalAccepted ? "canonicalize" : "preserve"
    );
  }

  if (canonicalAccepted) {
    const previousReceipt = await readReceiptIfPresent(stateFile);
    if (previousReceipt && !isRecognizedTransitionReceipt(previousReceipt)) {
      throw new Error("Managed database transition state is invalid");
    }
    const transitionReceipt = isChangedTransitionReceipt(previousReceipt)
      ? receipt("reconciled", true, "managed-password-accepted-after-recorded-transition")
      : receipt("unchanged", false, "managed-password-already-accepted");
    await writeReceipt(stateFile, transitionReceipt, receiptFilesystem);
    console.info(
      transitionReceipt.changed
        ? "Managed database still accepts POSTGRES_PASSWORD; preserved the recorded credential transition."
        : "Managed database already accepts POSTGRES_PASSWORD."
    );
    return reconciliationResult(transitionReceipt, environmentAction);
  }

  let legacyClient;
  let transactionStarted = false;
  try {
    legacyClient = await connectClient(LEGACY_MANAGED_DATABASE_URL);
    await legacyClient.query("BEGIN");
    transactionStarted = true;
    await legacyClient.query(`ALTER ROLE composebastion PASSWORD '${password}'`);
    // Record the intended changed state before committing. PostgreSQL rolls the
    // ALTER back if this process exits before COMMIT; if COMMIT completes, the
    // receipt is already durable enough for interruption recovery.
    await writeReceipt(
      stateFile,
      receipt("pending", true, "legacy-password-rotation-pending-verification"),
      receiptFilesystem
    );
    await legacyClient.query("COMMIT");
  } catch {
    if (transactionStarted) await legacyClient?.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      "Managed database accepts neither POSTGRES_PASSWORD nor the repository legacy credential; preserve the working DATABASE_URL and review the upgrade guide"
    );
  } finally {
    await legacyClient?.end().catch(() => undefined);
  }

  if (!(await acceptsConnection(canonicalUrl))) {
    throw new Error("Managed database credential rotation did not pass verification");
  }
  const transitionReceipt = receipt("reconciled", true, "legacy-password-rotated");
  await writeReceipt(stateFile, transitionReceipt, receiptFilesystem);
  console.info("Reconciled the repository legacy database credential with POSTGRES_PASSWORD.");
  return reconciliationResult(transitionReceipt, environmentAction);
}

export async function restoreLegacyManagedDatabase({
  configuredUrl = process.env.DATABASE_URL,
  postgresPassword = process.env.POSTGRES_PASSWORD || "",
  stateFile,
  acceptsConnection = accepts,
  connectClient = connect
} = {}) {
  const transitionReceipt = await readReceipt(stateFile);
  if (transitionReceipt?.schema !== 1 || transitionReceipt?.transition !== DATABASE_TRANSITION) {
    throw new Error("Credential restoration requires a valid transition receipt");
  }
  if (transitionReceipt?.changed === false && transitionReceipt?.status === "unchanged") {
    console.info("Recorded database transition did not change a credential; restoration is unnecessary.");
    return transitionReceipt;
  }
  if (transitionReceipt?.changed === true && transitionReceipt?.status === "restored") {
    if (!(await acceptsConnection(LEGACY_MANAGED_DATABASE_URL))) {
      throw new Error("Recorded legacy credential restoration no longer passes verification");
    }
    console.info("Managed database legacy credential restoration is already complete.");
    return transitionReceipt;
  }
  if (configuredUrl !== LEGACY_MANAGED_DATABASE_URL) {
    throw new Error("Credential restoration is restricted to the exact repository legacy database URL");
  }
  if (transitionReceipt?.changed !== true
      || !["pending", "reconciled"].includes(transitionReceipt?.status)) {
    throw new Error("Credential restoration requires a valid changed-state transition receipt");
  }

  const password = validateManagedPassword(postgresPassword);
  if (await acceptsConnection(LEGACY_MANAGED_DATABASE_URL)) {
    const result = receipt("restored", true, "legacy-password-already-accepted");
    await writeReceipt(stateFile, result);
    console.info("Managed database already accepts the repository legacy credential.");
    return result;
  }

  let canonicalClient;
  try {
    canonicalClient = await connectClient(managedUrl(password));
    await canonicalClient.query("ALTER ROLE composebastion PASSWORD 'composebastion'");
  } catch {
    throw new Error("Managed database credential could not be restored from the recorded transition");
  } finally {
    await canonicalClient?.end().catch(() => undefined);
  }

  if (!(await acceptsConnection(LEGACY_MANAGED_DATABASE_URL))) {
    throw new Error("Managed database legacy credential restoration did not pass verification");
  }
  const result = receipt("restored", true, "managed-password-rotated-to-legacy");
  await writeReceipt(stateFile, result);
  console.info("Restored the repository legacy database credential after a failed upgrade.");
  return result;
}

function parseCli(argv) {
  const args = [...argv];
  const mode = args[0] && !args[0].startsWith("--") ? args.shift() : "reconcile";
  let stateFile = null;
  let environmentProbe = null;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--state-file") {
      stateFile = args.shift() || null;
      continue;
    }
    if (argument === "--environment-probe") {
      environmentProbe = args.shift() || null;
      continue;
    }
    throw new Error(`Unknown database upgrade argument: ${argument}`);
  }
  if (!["reconcile", "restore-legacy"].includes(mode)) {
    throw new Error(`Unknown database upgrade mode: ${mode}`);
  }
  return { mode, stateFile, environmentProbe };
}

async function main() {
  const { mode, stateFile, environmentProbe } = parseCli(process.argv.slice(2));
  if (mode === "restore-legacy") {
    await restoreLegacyManagedDatabase({ stateFile });
  } else {
    const rawEnvironmentUrl = environmentProbe
      ? await readRawEnvironmentProbe(environmentProbe)
      : undefined;
    const result = await reconcileManagedDatabase({ stateFile, rawEnvironmentUrl });
    console.info(`COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=${result.credentialTransition}`);
    console.info(`COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=${result.environmentAction}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
