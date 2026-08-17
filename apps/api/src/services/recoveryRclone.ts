import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  rcloneRemoteNameIssue,
  smbShareIssue,
  smbSubPathIssue
} from "@composebastion/shared";
import type { WorkerBackupTarget } from "./recoveryBackupTargets.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const RCLONE_TEMP_PREFIX = "composebastion-rclone-";
export const RCLONE_TEMP_MAX_AGE_MS = 15 * 60_000;

export type RcloneHeadResult = {
  sizeBytes: number | null;
  checksum: string | null;
};

function rcloneBinary() {
  return process.env.RCLONE_PATH || "rclone";
}

function quoteConfigValue(value: unknown) {
  return String(value ?? "").replaceAll("\r", " ").replaceAll("\n", " ").trim();
}

function rcloneConfinementError(message: string) {
  return new Error(`Unsafe rclone target: ${message}`);
}

function assertRcloneTargetConfinement(target: WorkerBackupTarget) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  if (typeof target.rclone.remoteName !== "string") {
    throw rcloneConfinementError("Rclone remote name must be a string");
  }
  const remoteNameIssue = rcloneRemoteNameIssue(target.rclone.remoteName);
  if (remoteNameIssue) throw rcloneConfinementError(remoteNameIssue);
  if (target.rclone.provider !== "smb") return;
  if (target.rclone.configText !== null && target.rclone.configText !== undefined) {
    throw rcloneConfinementError("SMB targets cannot use an imported rclone config");
  }
  const smb = target.config.smb && typeof target.config.smb === "object" && !Array.isArray(target.config.smb)
    ? target.config.smb as Record<string, unknown>
    : null;
  if (!smb) throw rcloneConfinementError("SMB connection settings are missing");
  if (typeof smb.server !== "string" || !smb.server.trim()) {
    throw rcloneConfinementError("SMB server is required");
  }
  if (typeof smb.share !== "string") {
    throw rcloneConfinementError("SMB share must be a string");
  }
  const shareIssue = smbShareIssue(smb.share);
  if (shareIssue) throw rcloneConfinementError(shareIssue);
  if (smb.subPath !== null && smb.subPath !== undefined && typeof smb.subPath !== "string") {
    throw rcloneConfinementError("SMB subpath must be a string");
  }
  const subPath = typeof smb.subPath === "string" ? smb.subPath : "";
  const subPathIssue = smbSubPathIssue(subPath);
  if (subPathIssue) throw rcloneConfinementError(subPathIssue);
  const expectedRemotePath = subPath ? `${smb.share}/${subPath}` : smb.share;
  if (target.rclone.remotePath !== expectedRemotePath) {
    throw rcloneConfinementError("SMB remote path does not match its configured share and subpath");
  }
}

function execFileWithInput(file: string, args: string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    const child = execFile(file, args, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (!child.stdin) {
      settled = true;
      child.kill();
      reject(new Error("Could not open rclone password input"));
      return;
    }
    child.stdin.once("error", (error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function obscurePassword(password: string) {
  if (!password) return "";
  const result = await execFileWithInput(rcloneBinary(), ["obscure", "-"], `${password}\n`);
  return result.stdout.trim();
}

async function buildSmbConfig(target: WorkerBackupTarget) {
  assertRcloneTargetConfinement(target);
  const smb = target.config.smb && typeof target.config.smb === "object" && !Array.isArray(target.config.smb)
    ? target.config.smb as Record<string, unknown>
    : {};
  const password = typeof target.rclone?.credentials.password === "string"
    ? target.rclone.credentials.password
    : "";
  const lines = [
    `[${target.rclone?.remoteName ?? "composebastion"}]`,
    "type = smb",
    `host = ${quoteConfigValue(smb.server)}`
  ];
  if (smb.domain) lines.push(`domain = ${quoteConfigValue(smb.domain)}`);
  if (smb.username) lines.push(`user = ${quoteConfigValue(smb.username)}`);
  if (password) lines.push(`pass = ${await obscurePassword(password)}`);
  if (smb.port) lines.push(`port = ${quoteConfigValue(smb.port)}`);
  return `${lines.join("\n")}\n`;
}

async function resolveConfigText(target: WorkerBackupTarget) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  assertRcloneTargetConfinement(target);
  if (target.rclone.configText) return target.rclone.configText;
  if (target.rclone.provider === "smb") return buildSmbConfig(target);
  throw new Error("Rclone target requires an imported rclone config");
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function cleanupStaleRcloneConfigDirectories(options: {
  root?: string;
  maxAgeMs?: number;
  nowMs?: number;
} = {}) {
  const root = path.resolve(options.root ?? os.tmpdir());
  const maxAgeMs = options.maxAgeMs ?? RCLONE_TEMP_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error("Invalid rclone cleanup age");

  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  let skipped = 0;
  for (const entry of entries) {
    const suffix = entry.name.slice(RCLONE_TEMP_PREFIX.length);
    if (
      !entry.name.startsWith(RCLONE_TEMP_PREFIX)
      || !suffix
      || !/^[A-Za-z0-9._-]+$/.test(suffix)
    ) {
      continue;
    }
    const candidate = path.resolve(root, entry.name);
    if (path.dirname(candidate) !== root) {
      skipped += 1;
      continue;
    }

    let stats;
    try {
      stats = await lstat(candidate);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || (currentUid !== null && stats.uid !== currentUid)
      || nowMs - stats.mtimeMs < maxAgeMs
    ) {
      skipped += 1;
      continue;
    }
    await rm(candidate, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, skipped };
}

async function withConfigFile<T>(target: WorkerBackupTarget, work: (configPath: string) => Promise<T>) {
  await cleanupStaleRcloneConfigDirectories();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "composebastion-rclone-"));
  const configPath = path.join(tempDir, "rclone.conf");
  let completed = false;
  let operationResult!: T;
  let operationError: unknown;
  try {
    await writeFile(configPath, await resolveConfigText(target), { mode: 0o600 });
    operationResult = await work(configPath);
    completed = true;
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (!completed) {
    if (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Rclone operation failed and its secure temporary config could not be removed"
      );
    }
    throw operationError;
  }
  if (cleanupError) {
    throw new AggregateError(
      [cleanupError],
      "Rclone operation completed but its secure temporary config could not be removed"
    );
  }
  return operationResult;
}

async function runRclone(target: WorkerBackupTarget, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  return withConfigFile(target, async (configPath) => {
    const result = await execFileAsync(rcloneBinary(), ["--config", configPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  });
}

function isMissingRcloneObject(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const exitCode = (error as { code?: unknown }).code;
  // Rclone reserves exit codes 3 and 4 for a missing remote directory/file.
  // Do not infer idempotent success from generic stderr text: configuration
  // and credential-file failures can contain the same "no such file" wording.
  return exitCode === 3 || exitCode === 4;
}

function cleanRemotePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export function buildRcloneObjectPath(target: WorkerBackupTarget, objectKey: string) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  assertRcloneTargetConfinement(target);
  if (target.rclone.provider === "smb") {
    if (!objectKey) throw rcloneConfinementError("SMB object key is required");
    const objectKeyIssue = smbSubPathIssue(objectKey);
    if (objectKeyIssue) throw rcloneConfinementError(objectKeyIssue);
    return `${target.rclone.remoteName}:${target.rclone.remotePath}/${objectKey}`;
  }
  const parts = [cleanRemotePath(target.rclone.remotePath), cleanRemotePath(objectKey)].filter(Boolean);
  return `${target.rclone.remoteName}:${parts.join("/")}`;
}

export async function uploadRecoveryArtifactToRclone(
  target: WorkerBackupTarget,
  objectKey: string,
  localPath: string
) {
  const remote = buildRcloneObjectPath(target, objectKey);
  await runRclone(target, ["copyto", localPath, remote]);
  return headRecoveryArtifactOnRclone(target, objectKey);
}

export async function downloadRecoveryArtifactFromRclone(
  target: WorkerBackupTarget,
  objectKey: string,
  localPath: string
) {
  await mkdir(path.dirname(localPath), { recursive: true });
  await runRclone(target, ["copyto", buildRcloneObjectPath(target, objectKey), localPath]);
  return headRecoveryArtifactOnRclone(target, objectKey);
}

export async function headRecoveryArtifactOnRclone(
  target: WorkerBackupTarget,
  objectKey: string
): Promise<RcloneHeadResult> {
  const remote = buildRcloneObjectPath(target, objectKey);
  const result = await runRclone(target, ["lsjson", "--stat", remote], 120_000);
  const parsed = JSON.parse(result.stdout.trim() || "{}") as { Size?: number; Hashes?: Record<string, string> };
  const sha256 = parsed.Hashes?.SHA256 ?? parsed.Hashes?.sha256 ?? null;
  return {
    sizeBytes: typeof parsed.Size === "number" ? parsed.Size : null,
    checksum: sha256 ? `sha256:${sha256}` : null
  };
}

export async function deleteRecoveryArtifactFromRclone(target: WorkerBackupTarget, objectKey: string) {
  try {
    await runRclone(target, ["deletefile", buildRcloneObjectPath(target, objectKey)], 120_000);
  } catch (error) {
    // Deletion is deliberately idempotent so a retry can finish after a prior
    // attempt removed one object but failed on a later remote or local step.
    if (!isMissingRcloneObject(error)) throw error;
  }
}

export async function testRcloneTarget(target: WorkerBackupTarget) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  assertRcloneTargetConfinement(target);
  const base = `${target.rclone.remoteName}:${cleanRemotePath(target.rclone.remotePath)}`;
  await runRclone(target, ["mkdir", base], 120_000);
  await runRclone(target, ["lsf", base, "--max-depth", "1"], 120_000);
  return { ok: true };
}
