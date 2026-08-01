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

async function writeReceipt(stateFile, receipt) {
  if (!stateFile) return;
  const parent = await ensureStateParent(stateFile);
  const temporary = path.join(parent, `.${path.basename(stateFile)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, stateFile);
    await chmod(stateFile, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
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

export async function reconcileManagedDatabase({
  configuredUrl = process.env.DATABASE_URL,
  postgresPassword = process.env.POSTGRES_PASSWORD || "",
  stateFile = null,
  acceptsConnection = accepts,
  connectClient = connect
} = {}) {
  if (configuredUrl !== LEGACY_MANAGED_DATABASE_URL) {
    const result = receipt("unchanged", false, "explicit-or-derived-database-url");
    await writeReceipt(stateFile, result);
    console.info("Managed database credentials do not require legacy reconciliation.");
    return result;
  }

  const password = validateManagedPassword(postgresPassword);
  const canonicalUrl = managedUrl(password);
  if (await acceptsConnection(canonicalUrl)) {
    const previousReceipt = await readReceiptIfPresent(stateFile);
    if (previousReceipt && !isRecognizedTransitionReceipt(previousReceipt)) {
      throw new Error("Managed database transition state is invalid");
    }
    const result = isChangedTransitionReceipt(previousReceipt)
      ? receipt("reconciled", true, "managed-password-accepted-after-recorded-transition")
      : receipt("unchanged", false, "managed-password-already-accepted");
    await writeReceipt(stateFile, result);
    console.info(
      result.changed
        ? "Managed database still accepts POSTGRES_PASSWORD; preserved the recorded credential transition."
        : "Managed database already accepts POSTGRES_PASSWORD."
    );
    return result;
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
    await writeReceipt(stateFile, receipt("pending", true, "legacy-password-rotation-pending-verification"));
    await legacyClient.query("COMMIT");
    transactionStarted = false;
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
  const result = receipt("reconciled", true, "legacy-password-rotated");
  await writeReceipt(stateFile, result);
  console.info("Reconciled the repository legacy database credential with POSTGRES_PASSWORD.");
  return result;
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
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--state-file") {
      stateFile = args.shift() || null;
      continue;
    }
    throw new Error(`Unknown database upgrade argument: ${argument}`);
  }
  if (!["reconcile", "restore-legacy"].includes(mode)) {
    throw new Error(`Unknown database upgrade mode: ${mode}`);
  }
  return { mode, stateFile };
}

async function main() {
  const { mode, stateFile } = parseCli(process.argv.slice(2));
  if (mode === "restore-legacy") {
    await restoreLegacyManagedDatabase({ stateFile });
  } else {
    await reconcileManagedDatabase({ stateFile });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) await main();
